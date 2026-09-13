import { describe, expect, it } from 'vitest';

import {
  createSafetyStoreSecurity,
  LocalSafetyFieldProtector,
  ShanghaiKmsSafetyFieldProtector,
} from '../src/index.js';

describe('safety storage security', () => {
  it('encrypts local development fields instead of persisting plaintext', async () => {
    const security = createSafetyStoreSecurity({ NODE_ENV: 'test' });
    expect(security.fieldProtector).toBeInstanceOf(LocalSafetyFieldProtector);
    const plaintext = Buffer.from('sensitive child safety context');
    const protectedValue = await security.fieldProtector.protect(plaintext);
    expect(Buffer.from(protectedValue.ciphertext).toString('utf8')).not.toContain(
      plaintext.toString('utf8'),
    );
    expect(protectedValue.keyId).toBe('local-safety-key');
    await expect(
      security.fieldProtector.unprotect?.(protectedValue.ciphertext, protectedValue.keyId),
    ).resolves.toEqual(plaintext);
  });

  it('fails closed unless production uses the independent Shanghai safety KMS settings', () => {
    expect(() => createSafetyStoreSecurity({ NODE_ENV: 'production' })).toThrow(
      'SAFETY_TOKEN_PEPPER is required',
    );
    expect(() =>
      createSafetyStoreSecurity({
        NODE_ENV: 'production',
        SAFETY_TOKEN_PEPPER: 'production-safety-token-pepper-long-enough',
      }),
    ).toThrow('SAFETY_KMS_KEY_ID is required');
    expect(() =>
      createSafetyStoreSecurity({
        NODE_ENV: 'production',
        SAFETY_KMS_KEY_ID: 'kms-safety-shanghai',
        SAFETY_TOKEN_PEPPER: 'production-safety-token-pepper-long-enough',
      }),
    ).toThrow('WORKLOAD_CREDENTIALS_FILE is required');

    const security = createSafetyStoreSecurity({
      NODE_ENV: 'production',
      SAFETY_KMS_KEY_ID: 'kms-safety-shanghai',
      SAFETY_TOKEN_PEPPER: 'production-safety-token-pepper-long-enough',
      WORKLOAD_CREDENTIALS_FILE: '/run/rhea-credentials/credentials.json',
      WORKLOAD_ROLE_ARN: 'acs:ram::123456789:role/rhea-v1-workload-safety',
    });
    expect(security.fieldProtector).toBeInstanceOf(ShanghaiKmsSafetyFieldProtector);
  });
});
