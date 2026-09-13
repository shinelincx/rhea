import { GamificationService, MemoryGamificationStore } from '@rhea/learning-progress';
import { MemoryMetricsGovernanceStore, MetricsGovernanceService } from '@rhea/metrics-governance';
import { describe, expect, it, vi } from 'vitest';

import { DomainEventProjector } from '../src/domain-event-projector.js';

const scope = {
  family_space_id: 'family-1',
  learning_profile_id: 'profile-1',
};

describe('domain event projector', () => {
  it('projects authoritative learning events idempotently and fails closed on invalidation', async () => {
    const gamificationStore = new MemoryGamificationStore();
    const metricsStore = new MemoryMetricsGovernanceStore();
    const sourceAuthority = {
      learningEvidenceEventKeys: vi.fn(async () => ['evidence-1']),
      learningEvidenceEventKeysForAssessment: vi.fn(async () => []),
    };
    const projector = new DomainEventProjector(
      new GamificationService({ store: gamificationStore }),
      new MetricsGovernanceService(metricsStore),
      sourceAuthority,
    );
    const evidence = {
      ...scope,
      aggregate_id: 'evidence-1',
      aggregate_type: 'learning_evidence',
      event_type: 'learning_evidence.recorded',
      id: 'evidence-1',
      occurred_at: new Date('2026-09-19T04:00:00.000Z'),
      payload: { qualification: 'independent_success', themeId: 'fractions' },
    };

    await projector.project(evidence);
    await projector.project(evidence);
    expect(
      await new GamificationService({ store: gamificationStore }).getGrowth({
        familySpaceId: 'family-1',
        learningProfileId: 'profile-1',
      }),
    ).toMatchObject({ growthScore: 12, xp: 20 });
    expect(metricsStore.events.size).toBe(1);
    expect(metricsStore.events.get('evidence-1')?.payload).not.toHaveProperty('themeId');

    await projector.project({
      ...scope,
      aggregate_id: 'reopen-1',
      aggregate_type: 'wrong_item_theme',
      event_type: 'wrong_item_theme.reopened',
      id: 'reopen-1',
      occurred_at: new Date('2026-09-20T04:00:00.000Z'),
      payload: { reason: 'source_invalidated', themeId: 'fractions' },
    });

    expect(
      (
        await gamificationStore.listEvents({
          familySpaceId: 'family-1',
          learningProfileId: 'profile-1',
        })
      )[0]?.authorityState,
    ).toBe('invalidated');
    expect(metricsStore.events.get('evidence-1')?.authorityState).toBe('invalidated');
    expect(sourceAuthority.learningEvidenceEventKeys).toHaveBeenCalledOnce();
  });
});
