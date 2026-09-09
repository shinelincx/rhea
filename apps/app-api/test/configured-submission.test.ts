import { describe, expect, it } from 'vitest';

import { createConfiguredSubmission } from '../src/submission/create-configured-submission.js';

describe('configured submission boundary', () => {
  it('uses in-memory deterministic adapters only outside production', () => {
    const configured = createConfiguredSubmission({ NODE_ENV: 'test' });
    expect(configured.service).toBeDefined();
    expect(configured.shutdownResources).toEqual([]);
  });

  it('fails closed when production has no signed recognition adapter', () => {
    expect(() =>
      createConfiguredSubmission({ DATABASE_URL: 'postgresql://unused', NODE_ENV: 'production' }),
    ).toThrow('signed production recognition adapter');
  });
});
