import type { CaptureDraft } from './model';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface DraftCryptoPort {
  decrypt(profileId: string, context: string, ciphertext: Uint8Array): Promise<Uint8Array>;
  encrypt(profileId: string, context: string, plaintext: Uint8Array): Promise<Uint8Array>;
}

export interface DraftFilePort {
  list(profileId: string): Promise<string[]>;
  read(profileId: string, key: string): Promise<Uint8Array | null>;
  remove(profileId: string, key: string): Promise<void>;
  write(profileId: string, key: string, value: Uint8Array): Promise<void>;
}

export interface RestoredCaptureDraft {
  draft: CaptureDraft;
  pageContents: Map<string, Uint8Array>;
}

export interface CaptureDraftRepository {
  clear(draft: CaptureDraft): Promise<void>;
  loadLatest(learningProfileId: string): Promise<RestoredCaptureDraft | null>;
  save(draft: CaptureDraft, pageContents: ReadonlyMap<string, Uint8Array>): Promise<void>;
}

function metadataKey(draftId: string): string {
  return `${draftId}.metadata.enc`;
}

function pageKey(draftId: string, pageId: string): string {
  return `${draftId}.${pageId}.page.enc`;
}

export class EncryptedCaptureDraftRepository implements CaptureDraftRepository {
  constructor(
    private readonly crypto: DraftCryptoPort,
    private readonly files: DraftFilePort,
  ) {}

  async save(draft: CaptureDraft, pageContents: ReadonlyMap<string, Uint8Array>): Promise<void> {
    const allowedKeys = new Set([metadataKey(draft.id)]);
    for (const page of draft.pages) {
      const key = pageKey(draft.id, page.id);
      allowedKeys.add(key);
      const content = pageContents.get(page.id);
      if (content) {
        await this.files.write(
          draft.learningProfileId,
          key,
          await this.crypto.encrypt(draft.learningProfileId, key, content),
        );
      } else if (!(await this.files.read(draft.learningProfileId, key))) {
        throw new Error(`Missing content for draft page ${page.id}`);
      }
    }
    const metadata = textEncoder.encode(JSON.stringify(draft));
    const metaKey = metadataKey(draft.id);
    await this.files.write(
      draft.learningProfileId,
      metaKey,
      await this.crypto.encrypt(draft.learningProfileId, metaKey, metadata),
    );
    for (const key of await this.files.list(draft.learningProfileId)) {
      if (!allowedKeys.has(key)) {
        await this.files.remove(draft.learningProfileId, key);
      }
    }
  }

  async loadLatest(learningProfileId: string): Promise<RestoredCaptureDraft | null> {
    const keys = await this.files.list(learningProfileId);
    const metaKey = keys.find((key) => key.endsWith('.metadata.enc'));
    if (!metaKey) {
      return null;
    }
    const ciphertext = await this.files.read(learningProfileId, metaKey);
    if (!ciphertext) {
      return null;
    }
    const draft = JSON.parse(
      textDecoder.decode(await this.crypto.decrypt(learningProfileId, metaKey, ciphertext)),
    ) as CaptureDraft;
    if (draft.learningProfileId !== learningProfileId) {
      throw new Error('Encrypted draft belongs to a different learning profile');
    }
    const pageContents = new Map<string, Uint8Array>();
    for (const page of draft.pages) {
      const key = pageKey(draft.id, page.id);
      const pageCiphertext = await this.files.read(learningProfileId, key);
      if (!pageCiphertext) {
        throw new Error(`Encrypted draft page ${page.id} is missing`);
      }
      pageContents.set(page.id, await this.crypto.decrypt(learningProfileId, key, pageCiphertext));
    }
    return { draft, pageContents };
  }

  async clear(draft: CaptureDraft): Promise<void> {
    for (const key of await this.files.list(draft.learningProfileId)) {
      if (key.startsWith(`${draft.id}.`)) {
        await this.files.remove(draft.learningProfileId, key);
      }
    }
  }
}

export class MemoryDraftFilePort implements DraftFilePort {
  readonly #values = new Map<string, Uint8Array>();

  list(profileId: string): Promise<string[]> {
    return Promise.resolve(
      [...this.#values.keys()]
        .filter((key) => key.startsWith(`${profileId}:`))
        .map((key) => key.slice(profileId.length + 1)),
    );
  }

  read(profileId: string, key: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.#values.get(`${profileId}:${key}`) ?? null);
  }

  async remove(profileId: string, key: string): Promise<void> {
    this.#values.delete(`${profileId}:${key}`);
  }

  async write(profileId: string, key: string, value: Uint8Array): Promise<void> {
    this.#values.set(`${profileId}:${key}`, value);
  }
}
