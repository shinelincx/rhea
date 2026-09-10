import { describe, expect, it } from 'vitest';

import { FamilyAccessError, createInMemoryFamilyAccess, type Clock } from '../src/index.js';

class MutableClock implements Clock {
  now = new Date('2026-09-09T05:00:00.000Z');

  advance(minutes: number) {
    this.now = new Date(this.now.getTime() + minutes * 60_000);
  }
}

async function createFamilyFixture(
  subject: string,
  clock = new MutableClock(),
  familyAccess = createInMemoryFamilyAccess({ clock }),
) {
  const guardian = await familyAccess.loginGuardian({ identityAssertion: subject });
  const family = await familyAccess.createFamilySpace({
    accessToken: guardian.accessToken,
    name: `${subject}的家庭`,
  });
  const profile = await familyAccess.createLearningProfile({
    accessToken: guardian.accessToken,
    displayName: `${subject}同学`,
    familySpaceId: family.id,
    grade: 3,
    pin: '2468',
  });
  const device = await familyAccess.registerDevice({
    accessToken: guardian.accessToken,
    familySpaceId: family.id,
    label: '共享平板',
  });

  return { clock, device, family, familyAccess, guardian, profile };
}

describe('FamilyAccess public interface', () => {
  it('keeps each controlled purpose off until a recently reverified guardian decides it', async () => {
    const fixture = await createFamilyFixture('guardian-consent');

    const initial = await fixture.familyAccess.listConsents({
      accessToken: fixture.guardian.accessToken,
      familySpaceId: fixture.family.id,
    });

    expect(initial.map(({ kind, status }) => ({ kind, status }))).toEqual([
      { kind: 'photo_processing', status: 'not_decided' },
      { kind: 'ai_processing', status: 'not_decided' },
      { kind: 'peer_challenge', status: 'not_decided' },
      { kind: 'notifications', status: 'not_decided' },
    ]);
    expect(
      initial.every(({ dataScope, purpose }) => dataScope.length > 0 && purpose.length > 0),
    ).toBe(true);
    await expect(
      fixture.familyAccess.changeConsent({
        accessToken: fixture.guardian.accessToken,
        familySpaceId: fixture.family.id,
        granted: true,
        kind: 'photo_processing',
      }),
    ).rejects.toMatchObject({ code: 'GUARDIAN_REVERIFICATION_REQUIRED' });

    await fixture.familyAccess.reverifyGuardian({
      accessToken: fixture.guardian.accessToken,
      identityAssertion: 'guardian-consent',
    });
    await expect(
      fixture.familyAccess.authorizeSensitive({
        accessToken: fixture.guardian.accessToken,
        capability: 'data.export',
        familySpaceId: fixture.family.id,
      }),
    ).resolves.toMatchObject({ type: 'guardian' });
    const granted = await fixture.familyAccess.changeConsent({
      accessToken: fixture.guardian.accessToken,
      familySpaceId: fixture.family.id,
      granted: true,
      kind: 'photo_processing',
    });

    expect(granted).toMatchObject({ revision: 1, status: 'granted' });
    fixture.clock.advance(6);
    await expect(
      fixture.familyAccess.authorizeSensitive({
        accessToken: fixture.guardian.accessToken,
        capability: 'data.erase',
        familySpaceId: fixture.family.id,
      }),
    ).rejects.toMatchObject({ code: 'GUARDIAN_REVERIFICATION_REQUIRED' });
    await expect(
      fixture.familyAccess.requireConsent({
        accessToken: fixture.guardian.accessToken,
        familySpaceId: fixture.family.id,
        kind: 'ai_processing',
      }),
    ).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
  });

  it('records denial and withdrawal without presenting withdrawal as historical deletion', async () => {
    const fixture = await createFamilyFixture('guardian-withdrawal');
    await fixture.familyAccess.reverifyGuardian({
      accessToken: fixture.guardian.accessToken,
      identityAssertion: 'guardian-withdrawal',
    });

    await fixture.familyAccess.changeConsent({
      accessToken: fixture.guardian.accessToken,
      familySpaceId: fixture.family.id,
      granted: false,
      kind: 'notifications',
    });
    await fixture.familyAccess.changeConsent({
      accessToken: fixture.guardian.accessToken,
      familySpaceId: fixture.family.id,
      granted: true,
      kind: 'ai_processing',
    });
    const withdrawn = await fixture.familyAccess.changeConsent({
      accessToken: fixture.guardian.accessToken,
      familySpaceId: fixture.family.id,
      granted: false,
      kind: 'ai_processing',
    });
    const history = await fixture.familyAccess.listConsentHistory({
      accessToken: fixture.guardian.accessToken,
      familySpaceId: fixture.family.id,
      kind: 'ai_processing',
    });

    expect(withdrawn).toMatchObject({ revision: 2, status: 'withdrawn' });
    expect(history.map(({ status }) => status)).toEqual(['granted', 'withdrawn']);
    expect(
      history.every(({ occurredAt, statementVersion }) => occurredAt && statementVersion),
    ).toBe(true);
    await expect(
      fixture.familyAccess.requireConsent({
        accessToken: fixture.guardian.accessToken,
        familySpaceId: fixture.family.id,
        kind: 'ai_processing',
      }),
    ).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
  });

  it('lets a verified guardian create a family, learning profile, and restricted learner session', async () => {
    const fixture = await createFamilyFixture('guardian-a');

    const visibleProfiles = await fixture.familyAccess.listDeviceProfiles({
      deviceAccessToken: fixture.device.accessToken,
    });
    const learner = await fixture.familyAccess.issueLearnerSession({
      deviceAccessToken: fixture.device.accessToken,
      learningProfileId: fixture.profile.id,
      pin: '2468',
    });

    expect(visibleProfiles).toEqual([
      {
        displayName: 'guardian-a同学',
        familySpaceId: fixture.family.id,
        grade: 3,
        id: fixture.profile.id,
      },
    ]);
    await expect(
      fixture.familyAccess.getSession({ accessToken: learner.accessToken }),
    ).resolves.toMatchObject({
      actor: {
        familySpaceId: fixture.family.id,
        learningProfileId: fixture.profile.id,
        type: 'learner',
      },
    });
    await expect(
      fixture.familyAccess.authorize({
        accessToken: learner.accessToken,
        capability: 'learning.submit',
      }),
    ).resolves.toMatchObject({ type: 'learner' });
    await expect(
      fixture.familyAccess.authorize({
        accessToken: learner.accessToken,
        capability: 'data.erase',
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('keeps profiles and sessions isolated when a shared device switches learners', async () => {
    const fixture = await createFamilyFixture('guardian-shared');
    const secondProfile = await fixture.familyAccess.createLearningProfile({
      accessToken: fixture.guardian.accessToken,
      displayName: '第二位学习者',
      familySpaceId: fixture.family.id,
      grade: 5,
      pin: '1357',
    });
    const firstSession = await fixture.familyAccess.issueLearnerSession({
      deviceAccessToken: fixture.device.accessToken,
      learningProfileId: fixture.profile.id,
      pin: '2468',
    });
    const secondSession = await fixture.familyAccess.issueLearnerSession({
      deviceAccessToken: fixture.device.accessToken,
      learningProfileId: secondProfile.id,
      pin: '1357',
    });

    const firstActor = await fixture.familyAccess.authorize({
      accessToken: firstSession.accessToken,
      capability: 'learning.read',
    });
    const secondActor = await fixture.familyAccess.authorize({
      accessToken: secondSession.accessToken,
      capability: 'learning.read',
    });

    expect(firstActor).toMatchObject({ learningProfileId: fixture.profile.id });
    expect(secondActor).toMatchObject({ learningProfileId: secondProfile.id });
    expect(firstActor).not.toMatchObject({ learningProfileId: secondProfile.id });
  });

  it('authorizes profile-scoped learning changes for its learner or managing guardian only', async () => {
    const clock = new MutableClock();
    const familyAccess = createInMemoryFamilyAccess({ clock });
    const first = await createFamilyFixture('guardian-scope-a', clock, familyAccess);
    const second = await createFamilyFixture('guardian-scope-b', clock, familyAccess);
    const learner = await familyAccess.issueLearnerSession({
      deviceAccessToken: first.device.accessToken,
      learningProfileId: first.profile.id,
      pin: '2468',
    });

    await expect(
      familyAccess.authorizeLearningProfile({
        accessToken: learner.accessToken,
        capability: 'learning.submit',
        familySpaceId: first.family.id,
        learningProfileId: first.profile.id,
      }),
    ).resolves.toMatchObject({ type: 'learner' });
    await expect(
      familyAccess.authorizeLearningProfile({
        accessToken: first.guardian.accessToken,
        capability: 'learning.submit',
        familySpaceId: first.family.id,
        learningProfileId: first.profile.id,
      }),
    ).resolves.toMatchObject({ type: 'guardian' });
    await expect(
      familyAccess.authorizeLearningProfile({
        accessToken: first.guardian.accessToken,
        capability: 'learning.read',
        familySpaceId: second.family.id,
        learningProfileId: second.profile.id,
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('reads the authoritative learning profile only through a matching authorized scope', async () => {
    const clock = new MutableClock();
    const familyAccess = createInMemoryFamilyAccess({ clock });
    const first = await createFamilyFixture('guardian-profile-read-a', clock, familyAccess);
    const second = await createFamilyFixture('guardian-profile-read-b', clock, familyAccess);
    const learner = await familyAccess.issueLearnerSession({
      deviceAccessToken: first.device.accessToken,
      learningProfileId: first.profile.id,
      pin: '2468',
    });

    await expect(
      familyAccess.getLearningProfile({
        accessToken: learner.accessToken,
        familySpaceId: first.family.id,
        learningProfileId: first.profile.id,
      }),
    ).resolves.toEqual(first.profile);
    await expect(
      familyAccess.getLearningProfile({
        accessToken: first.guardian.accessToken,
        familySpaceId: first.family.id,
        learningProfileId: first.profile.id,
      }),
    ).resolves.toEqual(first.profile);
    await expect(
      familyAccess.getLearningProfile({
        accessToken: first.guardian.accessToken,
        familySpaceId: second.family.id,
        learningProfileId: second.profile.id,
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(
      familyAccess.getLearningProfile({
        accessToken: learner.accessToken,
        familySpaceId: first.family.id,
        learningProfileId: second.profile.id,
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('provides a profile-bound AI-processing consent snapshot for trusted publication gates', async () => {
    const clock = new MutableClock();
    const familyAccess = createInMemoryFamilyAccess({ clock });
    const first = await createFamilyFixture('guardian-ai-gate-a', clock, familyAccess);
    const second = await createFamilyFixture('guardian-ai-gate-b', clock, familyAccess);

    await expect(
      familyAccess.getAiProcessingConsentSnapshotForPublication({
        familySpaceId: first.family.id,
        learningProfileId: first.profile.id,
      }),
    ).resolves.toMatchObject({
      familySpaceId: first.family.id,
      grade: 3,
      learningProfileId: first.profile.id,
      revision: 0,
      status: 'not_decided',
      updatedAt: null,
    });
    await expect(
      familyAccess.getAiProcessingConsentSnapshotForPublication({
        familySpaceId: first.family.id,
        learningProfileId: second.profile.id,
      }),
    ).resolves.toBeNull();

    await familyAccess.reverifyGuardian({
      accessToken: first.guardian.accessToken,
      identityAssertion: 'guardian-ai-gate-a',
    });
    await familyAccess.changeConsent({
      accessToken: first.guardian.accessToken,
      familySpaceId: first.family.id,
      granted: true,
      kind: 'ai_processing',
    });
    const granted = await familyAccess.getAiProcessingConsentSnapshotForPublication({
      familySpaceId: first.family.id,
      learningProfileId: first.profile.id,
    });

    expect(granted).toMatchObject({ revision: 1, status: 'granted' });
    expect(granted?.statementVersion).toBeTruthy();
    expect(granted?.updatedAt).toBe(clock.now.toISOString());

    await familyAccess.changeConsent({
      accessToken: first.guardian.accessToken,
      familySpaceId: first.family.id,
      granted: false,
      kind: 'ai_processing',
    });
    await expect(
      familyAccess.getAiProcessingConsentSnapshotForPublication({
        familySpaceId: first.family.id,
        learningProfileId: first.profile.id,
      }),
    ).resolves.toMatchObject({ revision: 2, status: 'withdrawn' });
  });

  it('does not reveal profiles from a different family space to a registered device', async () => {
    const clock = new MutableClock();
    const familyAccess = createInMemoryFamilyAccess({ clock });
    const first = await createFamilyFixture('guardian-first', clock, familyAccess);
    const second = await createFamilyFixture('guardian-second', clock, familyAccess);

    const visibleProfiles = await first.familyAccess.listDeviceProfiles({
      deviceAccessToken: first.device.accessToken,
    });

    expect(visibleProfiles.map(({ id }) => id)).toEqual([first.profile.id]);
    await expect(
      first.familyAccess.issueLearnerSession({
        deviceAccessToken: first.device.accessToken,
        learningProfileId: second.profile.id,
        pin: '2468',
      }),
    ).rejects.toMatchObject({ code: 'DEVICE_PROFILE_NOT_FOUND' });
  });

  it('returns recoverable feedback for expiration, logout, and repeated PIN failures', async () => {
    const clock = new MutableClock();
    const fixture = await createFamilyFixture('guardian-recovery', clock);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(
        fixture.familyAccess.issueLearnerSession({
          deviceAccessToken: fixture.device.accessToken,
          learningProfileId: fixture.profile.id,
          pin: '0000',
        }),
      ).rejects.toMatchObject({ code: 'PIN_INVALID', remainingAttempts: 5 - attempt });
    }
    await expect(
      fixture.familyAccess.issueLearnerSession({
        deviceAccessToken: fixture.device.accessToken,
        learningProfileId: fixture.profile.id,
        pin: '0000',
      }),
    ).rejects.toMatchObject({ code: 'PIN_LOCKED', retryAfterSeconds: 300 });
    await expect(
      fixture.familyAccess.issueLearnerSession({
        deviceAccessToken: fixture.device.accessToken,
        learningProfileId: fixture.profile.id,
        pin: '2468',
      }),
    ).rejects.toMatchObject({ code: 'PIN_LOCKED' });

    clock.advance(5);
    const learner = await fixture.familyAccess.issueLearnerSession({
      deviceAccessToken: fixture.device.accessToken,
      learningProfileId: fixture.profile.id,
      pin: '2468',
    });
    await fixture.familyAccess.logout({ accessToken: learner.accessToken });
    await expect(
      fixture.familyAccess.getSession({ accessToken: learner.accessToken }),
    ).rejects.toMatchObject({ code: 'SESSION_INVALID' });

    clock.advance(31);
    await expect(
      fixture.familyAccess.getSession({ accessToken: fixture.guardian.accessToken }),
    ).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });

  it('rejects invalid profile and PIN inputs with stable domain errors', async () => {
    const familyAccess = createInMemoryFamilyAccess();
    const guardian = await familyAccess.loginGuardian({ identityAssertion: 'guardian-input' });
    const family = await familyAccess.createFamilySpace({
      accessToken: guardian.accessToken,
      name: '输入校验家庭',
    });

    await expect(
      familyAccess.createLearningProfile({
        accessToken: guardian.accessToken,
        displayName: '',
        familySpaceId: family.id,
        grade: 7,
        pin: '12ab',
      }),
    ).rejects.toBeInstanceOf(FamilyAccessError);
  });
});
