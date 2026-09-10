import type { CapabilityRecord } from '@rhea/quality-control';
import { describe, expect, it } from 'vitest';

import { PostgresQualityControlStore } from '../src/index.js';

const capability: CapabilityRecord = {
  evaluationRuns: [],
  revision: 0,
  rollout: {
    allowedUseSlices: [],
    percentage: 0,
    stage: 'disabled',
    updatedAt: '2026-09-10T00:00:00.000Z',
  },
  signoffs: [],
  version: {
    adapter: { id: 'ocr-adapter', version: '1' },
    artifactHash: 'a'.repeat(64),
    capabilityKey: 'submission-recognition',
    id: 'ocr-v1',
    implementedBy: 'engineer-1',
    kind: 'ocr',
    modelOrEngine: { id: 'ocr-engine', version: '1' },
    policyVersion: 'processing-v1',
    promptOrConfig: { kind: 'config', version: '1' },
    provider: { id: 'provider-1', version: '2026-09' },
    region: 'cn-beijing',
    registeredAt: '2026-09-10T00:00:00.000Z',
    requiredSlicePolicyVersion: 'slices-v1',
    templateVersion: 'template-v1',
  },
};

describe('PostgresQualityControlStore', () => {
  it('rejects a mutation discriminator that does not match the aggregate delta', async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes('read_quality_capability')) {
          return { rows: [{ record: capability }] };
        }
        return { rows: [] };
      },
      release() {},
    };
    const pool = {
      async connect() {
        return client;
      },
    };
    const store = new PostgresQualityControlStore(pool as never);
    const changed = structuredClone(capability);
    changed.rollout = {
      allowedUseSlices: [
        {
          basisState: 'unclassified',
          gradeBand: 'unclassified',
          imageQuality: 'unclassified',
          questionType: 'unclassified',
          riskLevel: 'unclassified',
          subject: 'unclassified',
        },
      ],
      percentage: 0,
      stage: 'shadow',
      updatedAt: '2026-09-10T01:00:00.000Z',
    };

    await expect(
      store.saveCapability(
        changed,
        0,
        { aggregateId: 'ocr-v1', commandId: 'command-1', fingerprint: 'b'.repeat(64) },
        'evaluation',
      ),
    ).rejects.toThrow('mutation does not match');
    expect(queries.some((sql) => sql.includes('append_quality_evaluation'))).toBe(false);
  });

  it('runs runtime and governance operations under distinct database roles', async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes('read_quality_containment_state')) {
          return { rows: [{ state: { epoch: 1, orders: [] } }] };
        }
        return { rows: [] };
      },
      release() {},
    };
    const pool = {
      async connect() {
        return client;
      },
    };
    const store = new PostgresQualityControlStore(pool as never);

    await store.findContainmentState();
    await store.createCapability(capability, {
      aggregateId: 'ocr-v1',
      commandId: 'command-2',
      fingerprint: 'c'.repeat(64),
    });

    expect(queries).toContain('SET LOCAL ROLE rhea_quality_runtime');
    expect(queries).toContain('SET LOCAL ROLE rhea_quality_governance');
  });
});
