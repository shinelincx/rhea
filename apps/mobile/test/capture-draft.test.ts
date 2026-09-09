import {
  addDraftPages,
  createCaptureDraft,
  cropDraftPage,
  deleteDraftPage,
  moveDraftPage,
  replaceDraftPage,
  rotateDraftPage,
  validateDraft,
  type DraftPage,
} from '../src/capture-draft/model';
import {
  EncryptedCaptureDraftRepository,
  MemoryDraftFilePort,
  type DraftCryptoPort,
} from '../src/capture-draft/repository';

const now = '2026-09-09T09:00:00.000Z';

function page(id: string, overrides: Partial<DraftPage> = {}): DraftPage {
  return {
    crop: null,
    fileName: `${id}.jpg`,
    height: 1600,
    id,
    mimeType: 'image/jpeg',
    qualityWarnings: [],
    rotation: 0,
    sizeBytes: 1_000,
    width: 1200,
    ...overrides,
  };
}

const xorCrypto: DraftCryptoPort = {
  decrypt: async (_profileId, _context, value) => value.map((byte) => byte ^ 0xa5),
  encrypt: async (_profileId, _context, value) => value.map((byte) => byte ^ 0xa5),
};

describe('capture draft model', () => {
  it('supports rotate, crop, reorder, retake, and delete without mutating earlier states', () => {
    const empty = createCaptureDraft({ id: 'draft-1', learningProfileId: 'profile-1', now });
    const added = addDraftPages(empty, [page('a'), page('b')], now);
    const rotated = rotateDraftPage(added, 'a', now);
    const cropped = cropDraftPage(rotated, 'a', now);
    const moved = moveDraftPage(cropped, 'b', -1, now);
    const replaced = replaceDraftPage(
      moved,
      'a',
      page('replacement', { fileName: 'new.jpg' }),
      now,
    );
    const deleted = deleteDraftPage(replaced, 'b', now);

    expect(empty.pages).toEqual([]);
    expect(cropped.pages[0]).toMatchObject({ crop: { width: 0.92 }, rotation: 90 });
    expect(moved.pages.map(({ id }) => id)).toEqual(['b', 'a']);
    expect(replaced.pages[1]).toMatchObject({ fileName: 'new.jpg', id: 'a', rotation: 0 });
    expect(deleted.pages.map(({ id }) => id)).toEqual(['a']);
  });

  it('validates page count, file type, individual size, and total size without deleting the draft', async () => {
    const draft = addDraftPages(
      createCaptureDraft({ id: 'draft-2', learningProfileId: 'profile-1', now }),
      [page('bad', { mimeType: 'text/plain', sizeBytes: 51 * 1024 * 1024 })],
      now,
    );
    const files = new MemoryDraftFilePort();
    const repository = new EncryptedCaptureDraftRepository(xorCrypto, files);
    await repository.save(draft, new Map([['bad', new Uint8Array([1, 2, 3])]]));

    expect(validateDraft(draft)).toMatchObject({ valid: false });
    await expect(repository.loadLatest('profile-1')).resolves.toMatchObject({
      draft: { id: 'draft-2', pages: [{ id: 'bad' }] },
    });
  });

  it('encrypts metadata and page bytes in a profile-scoped namespace', async () => {
    const files = new MemoryDraftFilePort();
    const repository = new EncryptedCaptureDraftRepository(xorCrypto, files);
    const draft = addDraftPages(
      createCaptureDraft({ id: 'draft-3', learningProfileId: 'profile-a', now }),
      [page('page-1', { fileName: '秘密数学作业.jpg' })],
      now,
    );
    await repository.save(draft, new Map([['page-1', new Uint8Array([10, 20, 30])]]));

    const rawMetadata = await files.read('profile-a', 'draft-3.metadata.enc');
    expect(new TextDecoder().decode(rawMetadata!)).not.toContain('秘密数学作业');
    await expect(repository.loadLatest('profile-b')).resolves.toBeNull();
    const restored = await repository.loadLatest('profile-a');
    expect(restored?.draft.pages[0]?.fileName).toBe('秘密数学作业.jpg');
    expect([...restored!.pageContents.get('page-1')!]).toEqual([10, 20, 30]);
  });
});
