import { randomUUID } from 'node:crypto';

import {
  evaluateWrongItemThemeMastery,
  qualifyLearningEvidence,
  WRONG_ITEM_THEME_MASTERY_POLICY_VERSION,
  type NewLearningEvidence,
  type ThemeMasteryRepository,
  type WrongItemThemeMasteryTransition,
  type WrongItemThemeMasteryView,
} from './theme-mastery.js';

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

export class MemoryThemeMasteryRepository implements ThemeMasteryRepository {
  readonly #themes = new Map<string, WrongItemThemeMasteryView>();

  find(themeId: string, learningProfileId: string): WrongItemThemeMasteryView | null {
    const theme = this.#themes.get(this.#key(themeId, learningProfileId));
    return theme ? clone(theme) : null;
  }

  registerTheme(
    input: Parameters<ThemeMasteryRepository['registerTheme']>[0],
  ): WrongItemThemeMasteryView {
    const key = this.#key(input.themeId, input.learningProfileId);
    const existing = this.#themes.get(key);
    if (!existing) {
      const theme: WrongItemThemeMasteryView = {
        cycle: 1,
        evidence: [],
        familySpaceId: input.familySpaceId,
        history: [
          this.#transition({
            cycle: 1,
            evidenceIds: [],
            fromStatus: null,
            kind: 'cycle_started',
            occurredAt: input.occurredAt,
            reason: input.reason === 'classification_changed' ? input.reason : 'first_error',
            toStatus: 'active',
            triggerKey: input.triggerKey,
          }),
        ],
        learningProfileId: input.learningProfileId,
        masteredAt: null,
        openedAt: input.occurredAt,
        policyVersion: WRONG_ITEM_THEME_MASTERY_POLICY_VERSION,
        stateRevision: 1,
        status: 'active',
        themeId: input.themeId,
      };
      this.#themes.set(key, theme);
      return clone(theme);
    }
    if (existing.history.some(({ triggerKey }) => triggerKey === input.triggerKey)) {
      return clone(existing);
    }
    if (
      existing.status === 'mastered' &&
      existing.masteredAt !== null &&
      new Date(input.occurredAt).getTime() > new Date(existing.masteredAt).getTime()
    ) {
      existing.cycle += 1;
      existing.history.push(
        this.#transition({
          cycle: existing.cycle,
          evidenceIds: [],
          fromStatus: 'mastered',
          kind: 'reopened',
          occurredAt: input.occurredAt,
          reason: input.reason,
          toStatus: 'active',
          triggerKey: input.triggerKey,
        }),
      );
      existing.masteredAt = null;
      existing.openedAt = input.occurredAt;
      existing.stateRevision += 1;
      existing.status = 'active';
    }
    return clone(existing);
  }

  recordEvidence(evidence: NewLearningEvidence): WrongItemThemeMasteryView | null {
    const key = this.#key(evidence.themeId, evidence.learningProfileId);
    const theme = this.#themes.get(key);
    if (!theme || theme.familySpaceId !== evidence.familySpaceId) return null;
    const duplicate = theme.evidence.find(
      (candidate) =>
        candidate.id === evidence.id ||
        (candidate.sourceKind === evidence.sourceKind &&
          candidate.sourceReferenceId === evidence.sourceReferenceId),
    );
    if (duplicate) return clone(theme);
    const qualification = qualifyLearningEvidence(evidence);
    if (qualification !== evidence.qualification) return null;
    if (
      theme.status === 'mastered' &&
      theme.masteredAt !== null &&
      evidence.outcome === 'incorrect' &&
      new Date(evidence.occurredAt).getTime() > new Date(theme.masteredAt).getTime()
    ) {
      theme.cycle += 1;
      theme.history.push(
        this.#transition({
          cycle: theme.cycle,
          evidenceIds: [],
          fromStatus: 'mastered',
          kind: 'reopened',
          occurredAt: evidence.occurredAt,
          reason: 'new_error',
          toStatus: 'active',
          triggerKey: `evidence:${evidence.id}:incorrect`,
        }),
      );
      theme.masteredAt = null;
      theme.openedAt = evidence.occurredAt;
      theme.stateRevision += 1;
      theme.status = 'active';
    }
    theme.evidence.push(clone({ ...evidence, cycle: theme.cycle }));
    theme.stateRevision += 1;
    const decision = evaluateWrongItemThemeMastery(theme.evidence, theme.cycle);
    if (theme.status === 'active' && decision.mastered) {
      const qualifyingIds = new Set(decision.qualifyingEvidenceIds);
      const masteryOccurredAt = theme.evidence
        .filter(({ id }) => qualifyingIds.has(id))
        .reduce(
          (latest, item) =>
            new Date(item.occurredAt).getTime() > new Date(latest).getTime()
              ? item.occurredAt
              : latest,
          evidence.occurredAt,
        );
      theme.history.push(
        this.#transition({
          cycle: theme.cycle,
          evidenceIds: decision.qualifyingEvidenceIds,
          fromStatus: 'active',
          kind: 'mastered',
          occurredAt: masteryOccurredAt,
          reason: 'rule_satisfied',
          toStatus: 'mastered',
          triggerKey: `mastered:${theme.cycle}`,
        }),
      );
      theme.masteredAt = masteryOccurredAt;
      theme.stateRevision += 1;
      theme.status = 'mastered';
    }
    return clone(theme);
  }

  reopenForInvalidSource(
    input: Parameters<ThemeMasteryRepository['reopenForInvalidSource']>[0],
  ): WrongItemThemeMasteryView | null {
    const theme = this.#themes.get(this.#key(input.themeId, input.learningProfileId));
    if (!theme) return null;
    if (theme.history.some(({ triggerKey }) => triggerKey === input.triggerKey))
      return clone(theme);
    const fromStatus = theme.status;
    theme.cycle += 1;
    theme.history.push(
      this.#transition({
        cycle: theme.cycle,
        evidenceIds: [],
        fromStatus,
        kind: 'reopened',
        occurredAt: input.occurredAt,
        reason: 'source_invalidated',
        toStatus: 'active',
        triggerKey: input.triggerKey,
      }),
    );
    theme.masteredAt = null;
    theme.openedAt = input.occurredAt;
    theme.stateRevision += 1;
    theme.status = 'active';
    return clone(theme);
  }

  #key(themeId: string, learningProfileId: string): string {
    return `${learningProfileId}:${themeId}`;
  }

  #transition(
    transition: Omit<WrongItemThemeMasteryTransition, 'id'>,
  ): WrongItemThemeMasteryTransition {
    return { ...transition, id: randomUUID() };
  }
}
