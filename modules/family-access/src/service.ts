import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { FamilyAccessError } from './error.js';
import { createScryptPinHasher, type PinHasher } from './pin-hasher.js';
import type { FamilyAccessStore, SessionRecord } from './store.js';
import type {
  Actor,
  Capability,
  Clock,
  FamilyAccess,
  Grade,
  IdentityProviderPort,
  LearningProfile,
  SessionGrant,
} from './types.js';

const SESSION_DURATION_MS = 30 * 60_000;
const PIN_LOCK_DURATION_MS = 5 * 60_000;
const MAX_PIN_ATTEMPTS = 5;
const LEARNER_CAPABILITIES = new Set<Capability>([
  'challenge.use',
  'learning.read',
  'learning.submit',
  'review.use',
  'today.read',
]);

export interface FamilyAccessServiceDependencies {
  clock?: Clock;
  identityProvider: IdentityProviderPort;
  pinHasher?: PinHasher;
  store: FamilyAccessStore;
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 80) {
    throw new FamilyAccessError('INPUT_INVALID', `${label}不能为空且不能超过 80 个字符`);
  }
  return normalized;
}

function requiredIdentityAssertion(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 8_192) {
    throw new FamilyAccessError('INPUT_INVALID', '身份凭证不能为空或过长');
  }
  return normalized;
}

function checkedGrade(value: number | null): Grade | null {
  if (value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 1 || value > 6) {
    throw new FamilyAccessError('INPUT_INVALID', '年级必须是一至六年级');
  }
  return value as Grade;
}

function checkedPin(pin: string): string {
  if (!/^\d{4,6}$/.test(pin)) {
    throw new FamilyAccessError('INPUT_INVALID', 'PIN 必须为 4 至 6 位数字');
  }
  return pin;
}

export class FamilyAccessService implements FamilyAccess {
  readonly #clock: Clock;
  readonly #identityProvider: IdentityProviderPort;
  readonly #pinHasher: PinHasher;
  readonly #store: FamilyAccessStore;

  constructor(dependencies: FamilyAccessServiceDependencies) {
    this.#clock = dependencies.clock ?? {
      get now() {
        return new Date();
      },
    };
    this.#identityProvider = dependencies.identityProvider;
    this.#pinHasher = dependencies.pinHasher ?? createScryptPinHasher();
    this.#store = dependencies.store;
  }

  async loginGuardian(input: { identityAssertion: string }): Promise<SessionGrant> {
    let identity: { subject: string };
    try {
      identity = await this.#identityProvider.verify(
        requiredIdentityAssertion(input.identityAssertion),
      );
    } catch (error) {
      if (error instanceof FamilyAccessError) {
        throw error;
      }
      throw new FamilyAccessError('IDENTITY_INVALID', '监护人登录凭证无效或已过期');
    }
    const guardian = await this.#store.upsertGuardian(identity.subject, randomUUID());
    return this.#createSession({ guardianId: guardian.id, type: 'guardian' });
  }

  async createFamilySpace(input: { accessToken: string; name: string }) {
    const guardian = await this.#requireGuardian(input.accessToken);
    const familySpace = { id: randomUUID(), name: requiredText(input.name, '家庭空间名称') };
    await this.#store.createFamilyWithManagingGuardian({
      familySpace,
      guardianId: guardian.guardianId,
    });
    return familySpace;
  }

  async createLearningProfile(input: {
    accessToken: string;
    displayName: string;
    familySpaceId: string;
    grade: number | null;
    pin: string;
  }): Promise<LearningProfile> {
    const guardian = await this.#requireManagingGuardian(input.accessToken, input.familySpaceId);
    void guardian;
    const profile = {
      displayName: requiredText(input.displayName, '学习档案名称'),
      failedPinAttempts: 0,
      familySpaceId: input.familySpaceId,
      grade: checkedGrade(input.grade),
      id: randomUUID(),
      pinHash: await this.#pinHasher.hash(checkedPin(input.pin)),
      pinLockedUntil: null,
    };
    await this.#store.createLearningProfile(profile);
    const { displayName, familySpaceId, grade, id } = profile;
    return { displayName, familySpaceId, grade, id };
  }

  async registerDevice(input: { accessToken: string; familySpaceId: string; label: string }) {
    await this.#requireManagingGuardian(input.accessToken, input.familySpaceId);
    const accessToken = newToken();
    const device = {
      familySpaceId: input.familySpaceId,
      id: randomUUID(),
      label: requiredText(input.label, '设备名称'),
      revokedAt: null,
      tokenHash: tokenHash(accessToken),
    };
    await this.#store.createDevice(device);
    return {
      accessToken,
      familySpaceId: device.familySpaceId,
      id: device.id,
      label: device.label,
    };
  }

  async listDeviceProfiles(input: { deviceAccessToken: string }): Promise<LearningProfile[]> {
    const device = await this.#requireDevice(input.deviceAccessToken);
    return this.#store.listLearningProfiles(device.familySpaceId);
  }

  async issueLearnerSession(input: {
    deviceAccessToken: string;
    learningProfileId: string;
    pin: string;
  }): Promise<SessionGrant> {
    const device = await this.#requireDevice(input.deviceAccessToken);
    const profile = await this.#store.findLearningProfile(
      input.learningProfileId,
      device.familySpaceId,
    );
    if (!profile) {
      throw new FamilyAccessError(
        'DEVICE_PROFILE_NOT_FOUND',
        '此设备无法进入该学习档案，请由监护人检查设备设置',
      );
    }

    const now = this.#clock.now;
    if (profile.pinLockedUntil && profile.pinLockedUntil > now) {
      throw this.#pinLocked(profile.pinLockedUntil, now);
    }
    const attemptsBeforeFailure = profile.pinLockedUntil ? 0 : profile.failedPinAttempts;
    const pinMatches = /^\d{4,6}$/.test(input.pin)
      ? await this.#pinHasher.verify(input.pin, profile.pinHash)
      : false;
    if (!pinMatches) {
      const failedPinAttempts = attemptsBeforeFailure + 1;
      if (failedPinAttempts >= MAX_PIN_ATTEMPTS) {
        const pinLockedUntil = new Date(now.getTime() + PIN_LOCK_DURATION_MS);
        await this.#store.savePinState({
          failedPinAttempts,
          familySpaceId: profile.familySpaceId,
          learningProfileId: profile.id,
          pinLockedUntil,
        });
        throw this.#pinLocked(pinLockedUntil, now);
      }
      await this.#store.savePinState({
        failedPinAttempts,
        familySpaceId: profile.familySpaceId,
        learningProfileId: profile.id,
        pinLockedUntil: null,
      });
      throw new FamilyAccessError('PIN_INVALID', 'PIN 不正确，请重试', {
        remainingAttempts: MAX_PIN_ATTEMPTS - failedPinAttempts,
      });
    }

    await this.#store.savePinState({
      failedPinAttempts: 0,
      familySpaceId: profile.familySpaceId,
      learningProfileId: profile.id,
      pinLockedUntil: null,
    });
    return this.#createSession({
      deviceId: device.id,
      familySpaceId: device.familySpaceId,
      learningProfileId: profile.id,
      type: 'learner',
    });
  }

  async getSession(input: { accessToken: string }) {
    const session = await this.#requireSession(input.accessToken);
    return { actor: session.actor, expiresAt: session.expiresAt.toISOString() };
  }

  async logout(input: { accessToken: string }): Promise<void> {
    const hash = tokenHash(input.accessToken);
    const session = await this.#store.findSessionByTokenHash(hash);
    if (!session || session.revokedAt) {
      throw new FamilyAccessError('SESSION_INVALID', '会话已退出，请重新进入');
    }
    await this.#store.revokeSession(hash, this.#clock.now);
  }

  async authorize(input: { accessToken: string; capability: Capability }): Promise<Actor> {
    const { actor } = await this.#requireSession(input.accessToken);
    if (actor.type === 'learner' && !LEARNER_CAPABILITIES.has(input.capability)) {
      throw new FamilyAccessError('CAPABILITY_DENIED', '此操作需要监护人进入监护模式后完成');
    }
    return actor;
  }

  async #createSession(actor: Actor): Promise<SessionGrant> {
    const accessToken = newToken();
    const expiresAt = new Date(this.#clock.now.getTime() + SESSION_DURATION_MS);
    await this.#store.createSession({
      actor,
      expiresAt,
      id: randomUUID(),
      revokedAt: null,
      tokenHash: tokenHash(accessToken),
    });
    return { accessToken, actor, expiresAt: expiresAt.toISOString() };
  }

  async #requireSession(accessToken: string): Promise<SessionRecord> {
    const session = await this.#store.findSessionByTokenHash(tokenHash(accessToken));
    if (!session || session.revokedAt) {
      throw new FamilyAccessError('SESSION_INVALID', '会话无效，请重新进入');
    }
    if (session.expiresAt <= this.#clock.now) {
      throw new FamilyAccessError('SESSION_EXPIRED', '会话已过期，请重新进入');
    }
    return session;
  }

  async #requireGuardian(accessToken: string) {
    const { actor } = await this.#requireSession(accessToken);
    if (actor.type !== 'guardian') {
      throw new FamilyAccessError('CAPABILITY_DENIED', '此操作需要监护人进入监护模式后完成');
    }
    return actor;
  }

  async #requireManagingGuardian(accessToken: string, familySpaceId: string) {
    const guardian = await this.#requireGuardian(accessToken);
    if (!(await this.#store.isManagingGuardian(guardian.guardianId, familySpaceId))) {
      throw new FamilyAccessError('FAMILY_ACCESS_DENIED', '无法管理该家庭空间');
    }
    return guardian;
  }

  async #requireDevice(accessToken: string) {
    const device = await this.#store.findDeviceByTokenHash(tokenHash(accessToken));
    if (!device || device.revokedAt) {
      throw new FamilyAccessError('DEVICE_INVALID', '设备入口无效，请由监护人重新设置');
    }
    return device;
  }

  #pinLocked(pinLockedUntil: Date, now: Date): FamilyAccessError {
    return new FamilyAccessError('PIN_LOCKED', 'PIN 尝试次数过多，请稍后再试', {
      retryAfterSeconds: Math.max(1, Math.ceil((pinLockedUntil.getTime() - now.getTime()) / 1_000)),
    });
  }
}
