import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { FamilyAccessError } from './error.js';
import { CONSENT_CATALOG, consentStatement } from './consent-catalog.js';
import { createScryptPinHasher, type PinHasher } from './pin-hasher.js';
import type { FamilyAccessStore, SessionRecord } from './store.js';
import type {
  Actor,
  Capability,
  Clock,
  ConsentHistoryEntry,
  ConsentKind,
  ConsentView,
  FamilyAccess,
  Grade,
  IdentityProviderPort,
  LearningProfile,
  SessionGrant,
} from './types.js';

const SESSION_DURATION_MS = 30 * 60_000;
const REVERIFICATION_DURATION_MS = 5 * 60_000;
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
    const profile = {
      displayName: requiredText(input.displayName, '学习档案名称'),
      failedPinAttempts: 0,
      familySpaceId: input.familySpaceId,
      grade: checkedGrade(input.grade),
      id: randomUUID(),
      pinHash: await this.#pinHasher.hash(checkedPin(input.pin)),
      pinLockedUntil: null,
    };
    await this.#store.createLearningProfile({ editorGuardianId: guardian.guardianId, profile });
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

  async authorizeLearningProfile(input: {
    accessToken: string;
    capability: 'learning.read' | 'learning.submit';
    familySpaceId: string;
    learningProfileId: string;
  }): Promise<Actor> {
    const actor = await this.authorize(input);
    if (actor.type === 'learner') {
      if (
        actor.familySpaceId !== input.familySpaceId ||
        actor.learningProfileId !== input.learningProfileId
      ) {
        throw new FamilyAccessError('CAPABILITY_DENIED', '不能访问其他学习档案的内容');
      }
      return actor;
    }
    const authorized =
      input.capability === 'learning.submit'
        ? await this.#store.canEditLearningContent({
            familySpaceId: input.familySpaceId,
            guardianId: actor.guardianId,
            learningProfileId: input.learningProfileId,
          })
        : (
            await Promise.all([
              this.#store.isManagingGuardian(actor.guardianId, input.familySpaceId),
              this.#store.findLearningProfile(input.learningProfileId, input.familySpaceId),
            ])
          ).every(Boolean);
    if (!authorized) {
      throw new FamilyAccessError('CAPABILITY_DENIED', '该监护人无权访问此学习档案');
    }
    return actor;
  }

  async authorizeSensitive(input: {
    accessToken: string;
    capability: 'data.erase' | 'data.export' | 'support_access.manage';
    familySpaceId: string;
  }) {
    void input.capability;
    return this.#requireRecentlyReverifiedManagingGuardian(input.accessToken, input.familySpaceId);
  }

  async reverifyGuardian(input: { accessToken: string; identityAssertion: string }) {
    const session = await this.#requireSession(input.accessToken);
    if (session.actor.type !== 'guardian') {
      throw new FamilyAccessError('CAPABILITY_DENIED', '此操作需要监护人进入监护模式后完成');
    }
    let identity: { subject: string };
    try {
      identity = await this.#identityProvider.verify(
        requiredIdentityAssertion(input.identityAssertion),
      );
    } catch (error) {
      if (error instanceof FamilyAccessError) {
        throw error;
      }
      throw new FamilyAccessError('IDENTITY_INVALID', '监护人重新验证失败，请再次登录');
    }
    const verifiedGuardian = await this.#store.findGuardianByIdentitySubject(identity.subject);
    if (!verifiedGuardian || verifiedGuardian.id !== session.actor.guardianId) {
      throw new FamilyAccessError('IDENTITY_INVALID', '重新验证的监护人与当前会话不一致');
    }
    const reverifiedAt = this.#clock.now;
    const marked = await this.#store.markSessionReverified(session.tokenHash, reverifiedAt);
    if (!marked) {
      throw new FamilyAccessError('SESSION_INVALID', '会话无效，请重新进入');
    }
    return {
      reverifiedAt: reverifiedAt.toISOString(),
      validUntil: new Date(reverifiedAt.getTime() + REVERIFICATION_DURATION_MS).toISOString(),
    };
  }

  async listConsents(input: {
    accessToken: string;
    familySpaceId: string;
  }): Promise<ConsentView[]> {
    await this.#requireManagingGuardian(input.accessToken, input.familySpaceId);
    const records = new Map(
      (await this.#store.listConsentRecords(input.familySpaceId)).map((record) => [
        record.kind,
        record,
      ]),
    );
    return CONSENT_CATALOG.map((statement) =>
      this.#consentView(input.familySpaceId, statement.kind, records.get(statement.kind) ?? null),
    );
  }

  async changeConsent(input: {
    accessToken: string;
    familySpaceId: string;
    granted: boolean;
    kind: ConsentKind;
  }): Promise<ConsentView> {
    const { guardianId } = await this.#requireRecentlyReverifiedManagingGuardian(
      input.accessToken,
      input.familySpaceId,
    );
    const statement = consentStatement(input.kind);
    const existing = await this.#store.findConsent(input.familySpaceId, input.kind);
    const status = input.granted
      ? ('granted' as const)
      : existing?.status === 'granted'
        ? ('withdrawn' as const)
        : ('denied' as const);
    const updatedAt = this.#clock.now;
    const record = {
      familySpaceId: input.familySpaceId,
      guardianId,
      kind: input.kind,
      revision: (existing?.revision ?? 0) + 1,
      statementVersion: statement.statementVersion,
      status,
      updatedAt,
    };
    await this.#store.saveConsentDecision(record, {
      ...record,
      id: randomUUID(),
      previousStatus: existing?.status ?? null,
    });
    return this.#consentView(input.familySpaceId, input.kind, record);
  }

  async listConsentHistory(input: {
    accessToken: string;
    familySpaceId: string;
    kind: ConsentKind;
  }): Promise<ConsentHistoryEntry[]> {
    await this.#requireManagingGuardian(input.accessToken, input.familySpaceId);
    return (await this.#store.listConsentEvents(input.familySpaceId, input.kind)).map((event) => ({
      occurredAt: event.updatedAt.toISOString(),
      previousStatus: event.previousStatus,
      revision: event.revision,
      statementVersion: event.statementVersion,
      status: event.status,
    }));
  }

  async requireConsent(input: {
    accessToken: string;
    familySpaceId: string;
    kind: ConsentKind;
  }): Promise<ConsentView> {
    const { actor } = await this.#requireSession(input.accessToken);
    if (actor.type === 'guardian') {
      if (!(await this.#store.isManagingGuardian(actor.guardianId, input.familySpaceId))) {
        throw new FamilyAccessError('FAMILY_ACCESS_DENIED', '无法访问该家庭空间');
      }
    } else if (actor.familySpaceId !== input.familySpaceId) {
      throw new FamilyAccessError('FAMILY_ACCESS_DENIED', '无法访问该家庭空间');
    }
    const record = await this.#store.findConsent(input.familySpaceId, input.kind);
    if (record?.status !== 'granted') {
      throw new FamilyAccessError('CONSENT_REQUIRED', '此功能尚未获得对应分项授权，请进入监护设置');
    }
    return this.#consentView(input.familySpaceId, input.kind, record);
  }

  async #createSession(actor: Actor): Promise<SessionGrant> {
    const accessToken = newToken();
    const expiresAt = new Date(this.#clock.now.getTime() + SESSION_DURATION_MS);
    await this.#store.createSession({
      actor,
      expiresAt,
      id: randomUUID(),
      reverifiedAt: null,
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

  async #requireRecentlyReverifiedManagingGuardian(accessToken: string, familySpaceId: string) {
    const session = await this.#requireSession(accessToken);
    if (session.actor.type !== 'guardian') {
      throw new FamilyAccessError('CAPABILITY_DENIED', '此操作需要监护人进入监护模式后完成');
    }
    if (!(await this.#store.isManagingGuardian(session.actor.guardianId, familySpaceId))) {
      throw new FamilyAccessError('FAMILY_ACCESS_DENIED', '无法管理该家庭空间');
    }
    if (
      !session.reverifiedAt ||
      session.reverifiedAt.getTime() + REVERIFICATION_DURATION_MS <= this.#clock.now.getTime()
    ) {
      throw new FamilyAccessError(
        'GUARDIAN_REVERIFICATION_REQUIRED',
        '请重新验证监护人身份后再修改授权',
      );
    }
    return session.actor;
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

  #consentView(
    familySpaceId: string,
    kind: ConsentKind,
    record: import('./store.js').ConsentRecord | null,
  ): ConsentView {
    const statement = consentStatement(kind);
    return {
      dataScope: [...statement.dataScope],
      familySpaceId,
      kind,
      purpose: statement.purpose,
      revision: record?.revision ?? 0,
      statementVersion: record?.statementVersion ?? statement.statementVersion,
      status: record?.status ?? 'not_decided',
      updatedAt: record?.updatedAt.toISOString() ?? null,
    };
  }
}
