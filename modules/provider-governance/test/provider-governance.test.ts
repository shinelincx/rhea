import { describe, expect, it } from 'vitest';

import {
  MemoryProviderGovernanceStore,
  ProviderGovernanceService,
  type EgressRequest,
  type ProviderCapability,
} from '../src/index.js';

const signedContract = {
  dataRegionSigned: true,
  deletionSlaSigned: true,
  exitMigrationSigned: true,
  incidentNoticeSigned: true,
  noTrainingSigned: true,
  retentionSigned: true,
  subprocessorsSigned: true,
  supportAccessSigned: true,
};

function capability(overrides: Partial<ProviderCapability> = {}): ProviderCapability {
  return {
    allowedDataCategories: ['confirmed_structured_learning_data'],
    allowedOrigins: ['https://model.example.cn'],
    capabilityVersionId: 'model-v1',
    contract: signedContract,
    enabled: true,
    kind: 'llm',
    providerId: 'mainland-model',
    region: 'cn-mainland',
    ...overrides,
  };
}

const request: EgressRequest = {
  capabilityVersionId: 'model-v1',
  dataCategories: ['confirmed_structured_learning_data'],
  destinationUrl: 'https://model.example.cn/v1/generate',
  payloadHash: 'a'.repeat(64),
  purpose: 'review_card',
  requestId: '00000000-0000-4000-8000-000000000001',
};

describe('ProviderGovernanceService', () => {
  it('allows only exact registered HTTPS origins, approved categories and signed capabilities', async () => {
    const store = new MemoryProviderGovernanceStore([capability()]);
    const service = new ProviderGovernanceService(store);
    await expect(service.authorize(request)).resolves.toMatchObject({
      allowed: true,
      reason: 'allowed',
    });
    await expect(
      service.authorize({ ...request, destinationUrl: 'https://sub.model.example.cn/v1/generate' }),
    ).resolves.toMatchObject({ allowed: false, reason: 'destination_denied' });
    await expect(
      service.authorize({ ...request, dataCategories: ['source_image'] }),
    ).resolves.toMatchObject({ allowed: false, reason: 'data_category_denied' });
    expect(store.audits).toHaveLength(2);
    expect(store.audits).toEqual(
      expect.arrayContaining([expect.objectContaining({ region: 'cn-mainland' })]),
    );
    expect(JSON.stringify(store.audits)).not.toContain('child answer');
  });

  it('fails closed until all eight provider contract decisions are signed', async () => {
    const store = new MemoryProviderGovernanceStore([
      capability({ contract: { ...signedContract, deletionSlaSigned: false } }),
    ]);
    const service = new ProviderGovernanceService(store);
    await expect(service.authorize(request)).resolves.toMatchObject({
      allowed: false,
      reason: 'contract_incomplete',
    });
  });

  it('rejects non-boolean contract values at registration and fails closed on poisoned storage', async () => {
    const poisoned = {
      ...capability(),
      contract: { ...signedContract, noTrainingSigned: 'false' },
    } as unknown as ProviderCapability;
    const registration = new ProviderGovernanceService(new MemoryProviderGovernanceStore());
    await expect(registration.registerCapability(poisoned)).rejects.toThrow(
      'PROVIDER_CAPABILITY_INVALID',
    );

    const authorization = new ProviderGovernanceService(
      new MemoryProviderGovernanceStore([poisoned]),
    );
    await expect(authorization.authorize(request)).resolves.toMatchObject({
      allowed: false,
      reason: 'capability_invalid',
    });
  });

  it('only registers OCR in Shanghai and rejects imprecise or insecure origins', async () => {
    const service = new ProviderGovernanceService(new MemoryProviderGovernanceStore());
    await expect(
      service.registerCapability(
        capability({
          capabilityVersionId: 'ocr-v1',
          kind: 'ocr',
          region: 'cn-beijing',
        }),
      ),
    ).rejects.toThrow('OCR 只能登记上海地域');
    await expect(
      service.registerCapability(capability({ allowedOrigins: ['http://model.example.cn'] })),
    ).rejects.toThrow('精确 HTTPS origin');
  });

  it('treats capability versions as immutable and permits only exact replay', async () => {
    const service = new ProviderGovernanceService(new MemoryProviderGovernanceStore());
    await service.registerCapability(capability());
    await expect(service.registerCapability(capability())).resolves.toBeUndefined();
    await expect(
      service.registerCapability(capability({ allowedOrigins: ['https://other.example.cn'] })),
    ).rejects.toThrow('PROVIDER_CAPABILITY_VERSION_CONFLICT');
  });

  it('treats JSON object and set-like list ordering as semantic replay', async () => {
    const service = new ProviderGovernanceService(new MemoryProviderGovernanceStore());
    const original = capability({
      allowedDataCategories: ['confirmed_structured_learning_data', 'minimal_crop'],
      allowedOrigins: ['https://model.example.cn', 'https://delete.model.example.cn'],
    });
    await service.registerCapability(original);
    await expect(
      service.registerCapability({
        ...original,
        allowedDataCategories: [...original.allowedDataCategories].reverse(),
        allowedOrigins: [...original.allowedOrigins].reverse(),
        contract: Object.fromEntries(
          Object.entries(original.contract).reverse(),
        ) as typeof original.contract,
      }),
    ).resolves.toBeUndefined();
  });
});
