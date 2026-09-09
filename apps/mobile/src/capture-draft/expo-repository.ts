import {
  AESEncryptionKey,
  AESSealedData,
  CryptoDigestAlgorithm,
  aesDecryptAsync,
  aesEncryptAsync,
  digestStringAsync,
} from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';

import type { DraftCryptoPort, DraftFilePort } from './repository';

function contextBase64(context: string): string {
  return btoa(context);
}

async function profileHash(profileId: string): Promise<string> {
  return digestStringAsync(CryptoDigestAlgorithm.SHA256, profileId);
}

export class ExpoAesDraftCryptoPort implements DraftCryptoPort {
  async encrypt(profileId: string, context: string, plaintext: Uint8Array) {
    const key = await this.#key(profileId);
    const sealed = await aesEncryptAsync(plaintext, key, {
      additionalData: contextBase64(context),
    });
    return sealed.combined();
  }

  async decrypt(profileId: string, context: string, ciphertext: Uint8Array) {
    const key = await this.#key(profileId);
    return aesDecryptAsync(AESSealedData.fromCombined(ciphertext), key, {
      additionalData: contextBase64(context),
      output: 'bytes',
    });
  }

  async #key(profileId: string): Promise<AESEncryptionKey> {
    const slot = `rhea.draft.key.${await profileHash(profileId)}`;
    const saved = await SecureStore.getItemAsync(slot);
    if (saved) {
      return AESEncryptionKey.import(saved, 'base64');
    }
    const generated = await AESEncryptionKey.generate(256);
    await SecureStore.setItemAsync(slot, await generated.encoded('base64'), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    return generated;
  }
}

export class InMemoryAesDraftCryptoPort implements DraftCryptoPort {
  readonly #keys = new Map<string, AESEncryptionKey>();

  async encrypt(profileId: string, context: string, plaintext: Uint8Array) {
    const sealed = await aesEncryptAsync(plaintext, await this.#key(profileId), {
      additionalData: contextBase64(context),
    });
    return sealed.combined();
  }

  async decrypt(profileId: string, context: string, ciphertext: Uint8Array) {
    return aesDecryptAsync(AESSealedData.fromCombined(ciphertext), await this.#key(profileId), {
      additionalData: contextBase64(context),
      output: 'bytes',
    });
  }

  async #key(profileId: string) {
    const existing = this.#keys.get(profileId);
    if (existing) {
      return existing;
    }
    const generated = await AESEncryptionKey.generate(256);
    this.#keys.set(profileId, generated);
    return generated;
  }
}

export class ExpoDraftFilePort implements DraftFilePort {
  async list(profileId: string): Promise<string[]> {
    const directory = await this.#directory(profileId, false);
    return directory?.exists ? directory.list().map((entry) => entry.name) : [];
  }

  async read(profileId: string, key: string): Promise<Uint8Array | null> {
    const directory = await this.#directory(profileId, false);
    if (!directory) {
      return null;
    }
    const file = new File(directory, key);
    return file.exists ? file.bytes() : null;
  }

  async remove(profileId: string, key: string): Promise<void> {
    const directory = await this.#directory(profileId, false);
    if (!directory) {
      return;
    }
    const file = new File(directory, key);
    if (file.exists) {
      file.delete();
    }
  }

  async write(profileId: string, key: string, value: Uint8Array): Promise<void> {
    const directory = await this.#directory(profileId, true);
    if (!directory) {
      throw new Error('Unable to create encrypted draft directory');
    }
    const file = new File(directory, key);
    file.create({ overwrite: true });
    file.write(value);
  }

  async #directory(profileId: string, create: boolean): Promise<Directory | null> {
    const root = new Directory(Paths.document, 'rhea-capture-drafts');
    const directory = new Directory(root, await profileHash(profileId));
    if (create && !directory.exists) {
      directory.create({ idempotent: true, intermediates: true });
    }
    return directory.exists ? directory : null;
  }
}
