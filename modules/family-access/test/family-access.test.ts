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
