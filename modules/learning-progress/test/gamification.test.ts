import { describe, expect, it } from 'vitest';
import {
  GamificationService,
  MemoryGamificationStore,
  type GamificationEvent,
} from '../src/index.js';

const clock = { now: new Date('2026-09-20T12:00:00.000Z') };
function event(
  kind: GamificationEvent['kind'],
  key: string,
  learningDate: string,
  overrides: Partial<GamificationEvent> = {},
): GamificationEvent {
  return {
    authorityState: 'accepted_current',
    eventKey: key,
    expiresAt: null,
    familySpaceId: 'family-1',
    kind,
    learningDate,
    learningProfileId: 'profile-1',
    occurredAt: learningDate + 'T01:00:00.000Z',
    sourceReferenceId: 'source-' + key,
    sourceVersion: 'v1',
    ...overrides,
  };
}

describe('non-punitive gamification', () => {
  it('calculates an explainable 60/30/10 growth score and explicit XP rewards', async () => {
    const service = new GamificationService({ clock, store: new MemoryGamificationStore() });
    for (let index = 0; index < 5; index += 1) {
      await service.recordEvent(
        event('learning_evidence_independent', 'learn-' + index, '2026-09-' + String(10 + index)),
      );
      await service.recordEvent(
        event('review_completed', 'review-' + index, '2026-09-' + String(10 + index)),
      );
    }
    for (let index = 0; index < 4; index += 1)
      await service.recordEvent(
        event('safe_challenge_completed', 'challenge-' + index, '2026-09-1' + index),
      );
    const growth = await service.getGrowth({
      familySpaceId: 'family-1',
      learningProfileId: 'profile-1',
    });
    expect(growth.growthScore).toBe(100);
    expect(growth.components.map(({ contribution, weight }) => [contribution, weight])).toEqual([
      [60, 60],
      [30, 30],
      [10, 10],
    ]);
    expect(growth.xp).toBe(215);
    expect(growth.level).toBe(3);
    expect(growth.badges.map(({ key }) => key)).toEqual([
      'first_step',
      'review_rhythm',
      'safe_participant',
      'steady_growth',
    ]);
    expect(growth.policy).toEqual({
      learningAccess: 'always_available',
      personalInformationRequired: false,
      purchaseRequired: false,
      ranking: 'none',
      speedAffectsScore: false,
    });
  });

  it('replays the same event without duplicate rewards and rejects a conflicting replay', async () => {
    const service = new GamificationService({ clock, store: new MemoryGamificationStore() });
    const value = event('learning_evidence_independent', 'same', '2026-09-19');
    expect((await service.recordEvent(value)).status).toBe('recorded');
    expect((await service.recordEvent(value)).status).toBe('replayed');
    await expect(service.recordEvent({ ...value, kind: 'review_completed' })).rejects.toMatchObject(
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    expect((await service.getGrowth(value)).xp).toBe(20);
  });

  it('excludes pending, disputed, invalidated, shadow, and expired evidence', async () => {
    const service = new GamificationService({ clock, store: new MemoryGamificationStore() });
    for (const authorityState of [
      'pending',
      'disputed',
      'invalidated',
      'shadow',
      'expired',
    ] as const)
      await service.recordEvent(
        event('learning_evidence_independent', authorityState, '2026-09-19', { authorityState }),
      );
    await service.recordEvent(
      event('learning_evidence_independent', 'time-expired', '2026-09-19', {
        expiresAt: '2026-09-20T11:59:00.000Z',
      }),
    );
    await service.recordEvent(event('learning_evidence_independent', 'current', '2026-09-19'));
    await service.updateEventAuthority({
      authorityState: 'disputed',
      eventKey: 'current',
      familySpaceId: 'family-1',
      learningProfileId: 'profile-1',
      sourceVersion: 'v2',
    });
    const growth = await service.getGrowth({
      familySpaceId: 'family-1',
      learningProfileId: 'profile-1',
    });
    expect(growth.growthScore).toBe(0);
    expect(growth.xp).toBe(0);
    expect(growth.excludedEvents).toEqual({
      disputed: 2,
      expired: 2,
      invalidated: 1,
      pending: 1,
      shadow: 1,
    });
  });

  it('keeps missed days and unsafe endings out of any penalty path', async () => {
    const service = new GamificationService({ clock, store: new MemoryGamificationStore() });
    await service.recordEvent(event('review_completed', 'day-1', '2026-09-10'));
    await service.recordEvent(event('review_completed', 'day-3', '2026-09-12'));
    const growth = await service.getGrowth({
      familySpaceId: 'family-1',
      learningProfileId: 'profile-1',
    });
    expect(growth.streak).toMatchObject({ bestDays: 1, currentDays: 0 });
    expect(growth.streak.message).toContain('不会扣分、扣 XP');
    expect(growth.components[2]?.explanation).toContain('退出、举报、断网或错过挑战均不扣分');
  });

  it('rejects calendar dates that JavaScript would otherwise normalize', async () => {
    const service = new GamificationService({ clock, store: new MemoryGamificationStore() });
    await expect(
      service.recordEvent(event('review_completed', 'invalid-date', '2026-02-31')),
    ).rejects.toMatchObject({ code: 'INPUT_INVALID' });
  });

  it('never reactivates evidence after a terminal authority transition', async () => {
    const store = new MemoryGamificationStore();
    const service = new GamificationService({ clock, store });
    const original = event('learning_evidence_independent', 'terminal', '2026-09-19');
    await service.recordEvent(original);
    await service.updateEventAuthority({
      authorityState: 'invalidated',
      eventKey: original.eventKey,
      familySpaceId: original.familySpaceId,
      learningProfileId: original.learningProfileId,
      sourceVersion: 'source-invalidated-v1',
    });

    expect((await service.recordEvent(original)).status).toBe('replayed');
    await service.updateEventAuthority({
      authorityState: 'disputed',
      eventKey: original.eventKey,
      familySpaceId: original.familySpaceId,
      learningProfileId: original.learningProfileId,
      sourceVersion: 'late-dispute-v1',
    });
    expect(await store.listEvents(original)).toEqual([
      expect.objectContaining({
        authorityState: 'invalidated',
        sourceVersion: 'source-invalidated-v1',
      }),
    ]);
    expect((await service.getGrowth(original)).xp).toBe(0);
  });
});
