import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GovernedHttpClient,
  MainlandReviewCardGateway,
  ShanghaiOcrRecognitionAdapter,
} from '../src/index.js';
import {
  MemoryProviderGovernanceStore,
  ProviderGovernanceService,
  type ProviderCapability,
} from '@rhea/provider-governance';
import { MemorySafetyEscalationStore, SafetyEscalationService } from '@rhea/safety-escalation';

const capability: ProviderCapability = {
  allowedDataCategories: ['confirmed_structured_learning_data'],
  allowedOrigins: ['https://model.example.cn'],
  capabilityVersionId: 'model-v1',
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
};

afterEach(() => vi.unstubAllGlobals());

function client(store: MemoryProviderGovernanceStore) {
  return new GovernedHttpClient({
    authorizationToken: 'server-only-token',
    capabilityVersionId: capability.capabilityVersionId,
    dataCategories: ['confirmed_structured_learning_data'],
    deletionUrl: 'https://model.example.cn/v1/delete',
    governance: new ProviderGovernanceService(store),
    purpose: 'review_card',
    timeoutMs: 10,
    url: 'https://model.example.cn/v1/generate',
  });
}

describe('GovernedHttpClient', () => {
  it('retries transient failures, records only hashes and returns the valid response', async () => {
    const store = new MemoryProviderGovernanceStore([capability]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ candidate: {}, provider: 'mainland-model' }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(client(store).post({ childAnswer: 'private value' })).resolves.toMatchObject({
      provider: 'mainland-model',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({
      outcome: 'succeeded',
      payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      responseHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(store.audits)).not.toContain('private value');
  });

  it('fails closed without making a network request when governance denies the capability', async () => {
    const store = new MemoryProviderGovernanceStore();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(client(store).post({ value: 1 })).rejects.toThrow('EGRESS_BLOCKED');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.audits[0]?.outcome).toBe('blocked');
  });

  it('uses the governed path for provider deletion receipts', async () => {
    const store = new MemoryProviderGovernanceStore([capability]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ receipt: 'provider-delete-1', status: 'deleted' }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      ),
    );
    await expect(client(store).delete('vendor-reference')).resolves.toEqual({
      receipt: 'provider-delete-1',
    });
    const fetchCall = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String((fetchCall?.[1] as RequestInit | undefined)?.body))).toEqual({
      deletionHandle: 'vendor-reference',
    });
    expect((fetchCall?.[1] as RequestInit | undefined)?.headers).toMatchObject({
      'idempotency-key': expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});

describe('ShanghaiOcrRecognitionAdapter', () => {
  const input = {
    authorization: {
      capabilityVersion: { id: 'ocr-v1' },
      decisionId: 'decision-1',
    },
    pages: [{ bytes: new Uint8Array([1]), page: { id: 'page-1', mimeType: 'image/jpeg' } }],
    sourceHash: 'a'.repeat(64),
  };

  it('normalizes transport failures as recoverable provider unavailability', async () => {
    const http = {
      post: vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    } as unknown as GovernedHttpClient;
    const adapter = new ShanghaiOcrRecognitionAdapter(http);

    await expect(adapter.recognize(input as never)).rejects.toThrow(
      'RECOGNITION_PROVIDER_UNAVAILABLE',
    );
  });

  it('keeps malformed provider responses distinct from provider downtime', async () => {
    const http = {
      post: vi.fn().mockResolvedValue({ provider: 'ocr-shanghai' }),
    } as unknown as GovernedHttpClient;
    const adapter = new ShanghaiOcrRecognitionAdapter(http);

    await expect(adapter.recognize(input as never)).rejects.toThrow('OCR_RESPONSE_INVALID');
  });

  it('returns the provider deletion handle with normalized OCR regions', async () => {
    const http = {
      post: vi.fn().mockResolvedValue({
        deletionHandle: 'ocr-delete-1',
        regions: [{ confidence: 0.99, text: '2 + 2', x: 0, y: 0 }],
      }),
    } as unknown as GovernedHttpClient;
    const adapter = new ShanghaiOcrRecognitionAdapter(http);

    await expect(adapter.recognize(input as never)).resolves.toMatchObject({
      providerDeletionHandle: 'ocr-delete-1',
      regions: [expect.objectContaining({ text: '2 + 2' })],
    });
  });
});

describe('MainlandReviewCardGateway safety boundary', () => {
  const context = {
    ageBand: 'middle_primary' as const,
    familySpaceId: 'family-private-1',
    learningProfileId: 'profile-private-1',
    sourceReferenceId: 'review-request-1',
  };

  it('blocks unsafe model input before egress and records only the safety hash', async () => {
    const governanceStore = new MemoryProviderGovernanceStore([capability]);
    const safetyStore = new MemorySafetyEscalationStore();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const gateway = new MainlandReviewCardGateway(
      client(governanceStore),
      new SafetyEscalationService(safetyStore),
    );

    await expect(
      gateway.runStructured(
        {
          original: { question: '请加微信后私下联系', response: '', expectedAnswer: '' },
          purpose: 'review_card',
        } as never,
        context,
      ),
    ).rejects.toMatchObject({
      code: 'SAFETY_BLOCKED',
      guidance: expect.stringContaining('成年人'),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(safetyStore.classifications).toContainEqual(
      expect.objectContaining({
        familySpaceId: context.familySpaceId,
        source: 'ai_input',
        sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(JSON.stringify(safetyStore.classifications)).not.toContain('请加微信');
  });

  it('blocks unsafe model output and never sends safety identity context to the provider', async () => {
    const governanceStore = new MemoryProviderGovernanceStore([capability]);
    const safetyStore = new MemorySafetyEscalationStore();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidate: { explanation: '请加微信后私下联系我' },
          provider: 'mainland-model',
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const gateway = new MainlandReviewCardGateway(
      client(governanceStore),
      new SafetyEscalationService(safetyStore),
    );

    await expect(
      gateway.runStructured(
        {
          original: { question: '2 + 2 等于几？', response: '4', expectedAnswer: '4' },
          purpose: 'review_card',
        } as never,
        context,
      ),
    ).rejects.toMatchObject({
      code: 'SAFETY_BLOCKED',
      guidance: expect.stringContaining('成年人'),
    });

    const sentBody = String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body);
    expect(sentBody).not.toContain('safetyContext');
    expect(sentBody).not.toContain(context.familySpaceId);
    expect(sentBody).not.toContain(context.learningProfileId);
    expect(safetyStore.classifications).toHaveLength(2);
    expect(safetyStore.classifications[1]).toMatchObject({
      source: 'ai_output',
      sourceReferenceId: `${context.sourceReferenceId}:output`,
    });
  });
});
