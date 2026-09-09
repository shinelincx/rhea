import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(nodeScrypt);

export interface PinHasher {
  hash(pin: string): Promise<string>;
  verify(pin: string, encodedHash: string): Promise<boolean>;
}

export function createScryptPinHasher(): PinHasher {
  return {
    async hash(pin) {
      const salt = randomBytes(16);
      const derived = (await scrypt(pin, salt, 32)) as Buffer;
      return `${salt.toString('base64url')}.${derived.toString('base64url')}`;
    },
    async verify(pin, encodedHash) {
      const [saltValue, expectedValue] = encodedHash.split('.');
      if (!saltValue || !expectedValue) {
        return false;
      }
      const expected = Buffer.from(expectedValue, 'base64url');
      const actual = (await scrypt(
        pin,
        Buffer.from(saltValue, 'base64url'),
        expected.length,
      )) as Buffer;
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
  };
}
