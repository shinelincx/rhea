import type {
  LearningEvidence,
  NewLearningEvidence,
  WrongItemThemeMasteryTransition,
  WrongItemThemeMasteryView,
} from '@rhea/learning-progress';
import type { PoolClient, QueryResultRow } from 'pg';

interface MasteryRow extends QueryResultRow {
  cycle: number;
  family_space_id: string;
  learning_profile_id: string;
  mastered_at: Date | null;
  opened_at: Date;
  policy_version: WrongItemThemeMasteryView['policyVersion'];
  state_revision: number;
  status: WrongItemThemeMasteryView['status'];
  theme_id: string;
}

interface EvidenceRow extends QueryResultRow {
  answer_exposure: LearningEvidence['answerExposure'];
  cycle: number;
  family_space_id: string;
  hint_usage: LearningEvidence['hintUsage'];
  id: string;
  learning_date: string | Date;
  learning_profile_id: string;
  occurred_at: Date;
  outcome: LearningEvidence['outcome'];
  qualification: LearningEvidence['qualification'];
  recorded_at: Date;
  source_kind: LearningEvidence['sourceKind'];
  source_reference_id: string;
  source_versions: unknown;
  theme_id: string;
  variation: unknown;
  wrong_item_id: string;
}

interface TransitionRow extends QueryResultRow {
  cycle: number;
  evidence_ids: string[];
  from_status: WrongItemThemeMasteryTransition['fromStatus'];
  id: string;
  kind: WrongItemThemeMasteryTransition['kind'];
  occurred_at: Date;
  reason: WrongItemThemeMasteryTransition['reason'];
  to_status: WrongItemThemeMasteryTransition['toStatus'];
  trigger_key: string;
}

function json<Value>(value: unknown): Value {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Value;
}

function learningDate(value: string | Date): string {
  if (typeof value === 'string') return value;
  return value.toISOString().slice(0, 10);
}

export async function findThemeMasteryInTransaction(
  client: PoolClient,
  themeId: string,
  learningProfileId: string,
): Promise<WrongItemThemeMasteryView | null> {
  const mastery = await client.query<MasteryRow>(
    `SELECT family_space_id, learning_profile_id, theme_id, status, cycle,
            policy_version, opened_at, mastered_at, state_revision
     FROM learning.wrong_item_theme_mastery
     WHERE learning_profile_id = $1 AND theme_id = $2`,
    [learningProfileId, themeId],
  );
  const row = mastery.rows[0];
  if (!row) return null;
  const [evidence, history] = await Promise.all([
    client.query<EvidenceRow>(
      `SELECT id, family_space_id, learning_profile_id, theme_id, wrong_item_id,
              cycle, source_kind, source_reference_id, outcome, hint_usage,
              answer_exposure, qualification, variation, learning_date,
              source_versions, occurred_at, recorded_at
       FROM learning.learning_evidence
       WHERE learning_profile_id = $1 AND theme_id = $2
       ORDER BY occurred_at, id`,
      [learningProfileId, themeId],
    ),
    client.query<TransitionRow>(
      `SELECT id, cycle, kind, reason, from_status, to_status,
              trigger_key, evidence_ids, occurred_at
       FROM learning.theme_mastery_transitions
       WHERE learning_profile_id = $1 AND theme_id = $2
       ORDER BY occurred_at, id`,
      [learningProfileId, themeId],
    ),
  ]);
  return {
    cycle: row.cycle,
    evidence: evidence.rows.map((item) => ({
      answerExposure: item.answer_exposure,
      cycle: item.cycle,
      familySpaceId: item.family_space_id,
      hintUsage: item.hint_usage,
      id: item.id,
      learningDate: learningDate(item.learning_date),
      learningProfileId: item.learning_profile_id,
      occurredAt: item.occurred_at.toISOString(),
      outcome: item.outcome,
      qualification: item.qualification,
      recordedAt: item.recorded_at.toISOString(),
      sourceKind: item.source_kind,
      sourceReferenceId: item.source_reference_id,
      sourceVersions: json(item.source_versions),
      themeId: item.theme_id,
      variation: json(item.variation),
      wrongItemId: item.wrong_item_id,
    })),
    familySpaceId: row.family_space_id,
    history: history.rows.map((transition) => ({
      cycle: transition.cycle,
      evidenceIds: transition.evidence_ids,
      fromStatus: transition.from_status,
      id: transition.id,
      kind: transition.kind,
      occurredAt: transition.occurred_at.toISOString(),
      reason: transition.reason,
      toStatus: transition.to_status,
      triggerKey: transition.trigger_key,
    })),
    learningProfileId: row.learning_profile_id,
    masteredAt: row.mastered_at?.toISOString() ?? null,
    openedAt: row.opened_at.toISOString(),
    policyVersion: row.policy_version,
    stateRevision: row.state_revision,
    status: row.status,
    themeId: row.theme_id,
  };
}

export async function recordEvidenceInTransaction(
  client: PoolClient,
  evidence: NewLearningEvidence,
): Promise<boolean> {
  const result = await client.query<{ recorded: boolean }>(
    `SELECT learning.record_learning_evidence($1::jsonb) AS recorded`,
    [JSON.stringify(evidence)],
  );
  return result.rows[0]?.recorded === true;
}

export async function registerThemeInTransaction(
  client: PoolClient,
  input: {
    learningProfileId: string;
    occurredAt: string;
    reason: 'classification_changed' | 'new_error';
    themeId: string;
    triggerKey: string;
    wrongItemId: string;
  },
): Promise<boolean> {
  const result = await client.query<{ registered: boolean }>(
    `SELECT learning.register_wrong_item_theme($1::jsonb) AS registered`,
    [JSON.stringify(input)],
  );
  return result.rows[0]?.registered === true;
}

export async function reopenThemeForInvalidSourceInTransaction(
  client: PoolClient,
  input: {
    learningProfileId: string;
    occurredAt: string;
    themeId: string;
    triggerKey: string;
  },
): Promise<boolean> {
  const result = await client.query<{ reopened: boolean }>(
    `SELECT learning.reopen_wrong_item_theme_source($1::jsonb) AS reopened`,
    [JSON.stringify(input)],
  );
  return result.rows[0]?.reopened === true;
}
