import { applyMigrations, loadDefaultMigrations } from '@rhea/database';
import {
  ProviderGovernanceService,
  type EgressRequest,
  type ProviderCapability,
} from '@rhea/provider-governance';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresProviderGovernanceStore } from '../src/index.js';

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;

describeWithDatabase('Postgres provider governance adapter', () => {
  const capabilityVersionId = `llm-${crypto.randomUUID()}`;
  const batchCapabilityVersionId = `llm-batch-${crypto.randomUUID()}`;
  const invalidCapabilityVersionId = `llm-invalid-${crypto.randomUUID()}`;
  const requestId = crypto.randomUUID();
  beforeAll(async () => {
    await applyMigrations(
      { query: async (sql, values) => ({ rows: (await pool!.query(sql, values)).rows }) },
      await loadDefaultMigrations(),
    );
  });
  afterAll(async () => {
    await pool?.query('DELETE FROM metrics.provider_egress_audit WHERE request_id=$1', [requestId]);
    await pool?.query('DELETE FROM metrics.provider_capabilities WHERE capability_version_id=$1', [
      capabilityVersionId,
    ]);
    await pool?.query('DELETE FROM metrics.provider_capabilities WHERE capability_version_id=$1', [
      batchCapabilityVersionId,
    ]);
    await pool?.query('DELETE FROM metrics.provider_capabilities WHERE capability_version_id=$1', [
      invalidCapabilityVersionId,
    ]);
    await pool?.end();
  });

  it('authorizes a signed mainland capability and writes a hash-only egress audit', async () => {
    const governance = new ProviderGovernanceService(
      new PostgresProviderGovernanceStore(pool!, 'rhea_provider_governance_admin'),
    );
    const service = new ProviderGovernanceService(new PostgresProviderGovernanceStore(pool!));
    await governance.registerCapability({
      allowedDataCategories: ['confirmed_structured_learning_data'],
      allowedOrigins: ['https://model.example.cn'],
      capabilityVersionId,
      contract: {
        dataRegionSigned: true,
        deletionSlaSigned: true,
        exitMigrationSigned: true,
        incidentNoticeSigned: true,
        noTrainingSigned: true,
        retentionSigned: true,
        subprocessorsSigned: true,
        supportAccessSigned: true,
      },
      enabled: true,
      kind: 'llm',
      providerId: 'mainland-model',
      region: 'cn-mainland',
    });
    const request: EgressRequest = {
      capabilityVersionId,
      dataCategories: ['confirmed_structured_learning_data'],
      destinationUrl: 'https://model.example.cn/v1/generate',
      payloadHash: 'a'.repeat(64),
      purpose: 'review_card',
      requestId,
    };
    const decision = await service.authorize(request);
    expect(decision).toMatchObject({ allowed: true });
    await service.record(request, {
      outcome: 'succeeded',
      providerId: 'mainland-model',
      responseHash: 'b'.repeat(64),
    });
    const audit = await pool!.query(
      'SELECT destination_origin,payload_hash,response_hash,outcome FROM metrics.provider_egress_audit WHERE request_id=$1',
      [requestId],
    );
    expect(audit.rows[0]).toEqual({
      destination_origin: 'https://model.example.cn',
      outcome: 'succeeded',
      payload_hash: 'a'.repeat(64),
      response_hash: 'b'.repeat(64),
    });
    const privileges = await pool!.query(
      "SELECT has_schema_privilege('rhea_provider_gateway','learning','USAGE') AS learning_access,has_schema_privilege('rhea_provider_gateway','safety','USAGE') AS safety_access",
    );
    expect(privileges.rows[0]).toEqual({ learning_access: false, safety_access: false });
  });

  it('uses semantic replay equality and rolls an invalid manifest batch back as one unit', async () => {
    const store = new PostgresProviderGovernanceStore(pool!, 'rhea_provider_governance_admin');
    const first: ProviderCapability = {
      allowedDataCategories: ['minimal_crop', 'source_image'],
      allowedOrigins: ['https://ocr-delete.example.cn', 'https://ocr.example.cn'],
      capabilityVersionId: batchCapabilityVersionId,
      contract: {
        dataRegionSigned: true,
        deletionSlaSigned: true,
        exitMigrationSigned: true,
        incidentNoticeSigned: true,
        noTrainingSigned: true,
        retentionSigned: true,
        subprocessorsSigned: true,
        supportAccessSigned: true,
      },
      enabled: true,
      kind: 'ocr',
      providerId: 'shanghai-ocr',
      region: 'cn-shanghai',
    };
    await store.saveCapabilitiesAtomically([first]);
    await expect(
      store.saveCapabilitiesAtomically([
        {
          ...first,
          allowedDataCategories: [...first.allowedDataCategories].reverse(),
          allowedOrigins: [...first.allowedOrigins].reverse(),
          contract: Object.fromEntries(
            Object.entries(first.contract).reverse(),
          ) as typeof first.contract,
        },
      ]),
    ).resolves.toBeUndefined();

    const rollbackId = `${batchCapabilityVersionId}-rollback`;
    await expect(
      store.saveCapabilitiesAtomically([
        { ...first, capabilityVersionId: rollbackId },
        { ...first, allowedOrigins: ['https://changed.example.cn'] },
      ]),
    ).rejects.toThrow('PROVIDER_CAPABILITY_VERSION_CONFLICT');
    await expect(store.findCapability(rollbackId)).resolves.toBeNull();

    await expect(
      pool!.query(
        `INSERT INTO metrics.provider_capabilities
          (capability_version_id,provider_id,kind,region,allowed_origins,allowed_data_categories,contract,enabled,updated_at)
         VALUES($1,'poisoned','llm','cn-mainland',ARRAY['https://model.example.cn'],
           ARRAY['confirmed_structured_learning_data'],$2::jsonb,true,now())`,
        [
          invalidCapabilityVersionId,
          JSON.stringify({ ...first.contract, noTrainingSigned: 'false' }),
        ],
      ),
    ).rejects.toThrow();
  });
});
