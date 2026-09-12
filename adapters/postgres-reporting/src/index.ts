import type {
  ExcludedReportFact,
  GuardianTodoCandidate,
  LearningEvidenceReportFact,
  ReportingAuthorityState,
  ReportingJsonValue,
  ReportingScope,
  ReportingSourceTrace,
  ReportingStateHistoryEntry,
  ReportingStore,
  ReportingSubject,
  ThemeStateReportFact,
  TodayRouteCandidate,
  WrongItemChangeReportFact,
} from '@rhea/reporting';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

const CONSENT_KINDS = [
  'photo_processing',
  'ai_processing',
  'peer_challenge',
  'notifications',
] as const;

const CONSENT_LABELS: Record<(typeof CONSENT_KINDS)[number], string> = {
  ai_processing: 'AI 处理',
  notifications: '通知',
  peer_challenge: '同伴挑战',
  photo_processing: '照片与文件处理',
};

interface ProcessingRow extends QueryResultRow {
  created_at: Date;
  error_code: string | null;
  id: string;
  revision: number;
  status: string;
  updated_at: Date;
}

interface SuggestedRow extends QueryResultRow {
  capability_version_id: string | null;
  created_at: Date;
  id: string;
  status: string;
  task_type: string;
  unavailable_reason: string | null;
  updated_at: Date;
}

interface DisputeRow extends QueryResultRow {
  assessment_id: string;
  assessment_version_id: string;
  id: string;
  raised_at: Date;
  review_route: string;
  target: string;
}

interface ReviewRow extends QueryResultRow {
  created_at: Date;
  due_at: Date;
  id: string;
  schedule: unknown;
  source_snapshot: unknown;
  version: number;
}

interface WrongItemRow extends QueryResultRow {
  assessment_snapshot: unknown;
  classification: unknown;
  created_at: Date;
  first_incorrect_at: Date;
  id: string;
  state_revision: number;
  status: 'pending_consolidation' | 'pending_correction';
  theme_id: string;
}

interface EvidenceRow extends QueryResultRow {
  authority_state: ReportingAuthorityState;
  classification: unknown;
  cycle: number;
  id: string;
  learning_date: string | Date;
  occurred_at: Date;
  outcome: LearningEvidenceReportFact['outcome'];
  qualification: LearningEvidenceReportFact['qualification'];
  source_kind: string;
  source_reference_id: string;
  source_versions: unknown;
  state_changed_at: Date;
  theme_id: string;
  wrong_item_id: string;
}

interface ThemeRow extends QueryResultRow {
  authority_state: ReportingAuthorityState;
  classification: unknown;
  cycle: number;
  mastered_at: Date | null;
  state_revision: number;
  status: ThemeStateReportFact['status'];
  theme_id: string;
  transitions: unknown;
}

interface ChangeRow extends QueryResultRow {
  authority_state: ReportingAuthorityState;
  classification: unknown;
  cycle: number;
  evidence_ids: string[];
  id: string;
  kind: 'cycle_started' | 'mastered' | 'reopened';
  occurred_at: Date;
  reason: string;
  theme_id: string;
  transitions: unknown;
}

function json<Value>(value: unknown): Value {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Value;
}

function iso(value: Date): string {
  return value.toISOString();
}

function subject(value: unknown): ReportingSubject {
  if (
    value === 'chinese' ||
    value === 'english' ||
    value === 'mathematics' ||
    value === 'science'
  ) {
    return value;
  }
  throw new Error('Stored reporting subject is invalid');
}

function classification(value: unknown): {
  knowledgePointName: string | null;
  status: 'classified' | 'pending';
  subject: ReportingSubject;
  unitName: string | null;
} {
  const record = json<Record<string, unknown>>(value);
  return {
    knowledgePointName:
      typeof record.primaryKnowledgePointName === 'string'
        ? record.primaryKnowledgePointName
        : null,
    status: record.status === 'pending' ? 'pending' : 'classified',
    subject: subject(record.subject),
    unitName: typeof record.unitName === 'string' ? record.unitName : null,
  };
}

function singleHistory(
  at: Date,
  state: ReportingAuthorityState,
  reason: string,
): ReportingStateHistoryEntry[] {
  return [{ at: iso(at), from: null, reason, to: state }];
}

function trace(input: {
  aggregateId: string;
  aggregateType: string;
  at: Date;
  history?: ReportingStateHistoryEntry[];
  reason: string;
  sourceVersions: Record<string, ReportingJsonValue>;
  state: ReportingAuthorityState;
}): ReportingSourceTrace {
  return {
    aggregateId: input.aggregateId,
    aggregateType: input.aggregateType,
    authorityState: input.state,
    history: input.history ?? singleHistory(input.at, input.state, input.reason),
    sourceVersions: input.sourceVersions,
  };
}

function evidenceHistory(row: EvidenceRow): ReportingStateHistoryEntry[] {
  if (row.authority_state === 'pending') {
    return singleHistory(row.occurred_at, 'pending', '错题主题仍待归类');
  }
  const history = singleHistory(row.occurred_at, 'accepted_current', '学习证据已记录');
  if (row.authority_state !== 'accepted_current') {
    history.push({
      at: iso(row.state_changed_at),
      from: 'accepted_current',
      reason:
        row.authority_state === 'disputed'
          ? '评价正在质疑中'
          : row.authority_state === 'expired'
            ? '评价版本已过期'
            : '学习来源已失效',
      to: row.authority_state,
    });
  }
  return history;
}

function masteryHistory(value: unknown): ReportingStateHistoryEntry[] {
  const rows = json<
    Array<{
      fromStatus: string | null;
      occurredAt: string;
      reason: string;
      toStatus: string;
    }>
  >(value);
  return rows.map((row) => ({
    at: new Date(row.occurredAt).toISOString(),
    from: row.fromStatus,
    reason: row.reason,
    to: row.toStatus,
  }));
}

function sortByCreatedAt<Value extends { createdAt: string; id: string }>(items: Value[]): Value[] {
  return items.sort(
    (left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id),
  );
}

export class PostgresReportingStore implements ReportingStore {
  constructor(readonly pool: Pool) {}

  async readTodayRouteCandidates(scope: ReportingScope, asOf: string) {
    return this.#withScope(scope, async (client) => {
      const items: TodayRouteCandidate[] = [];
      const processing = await client.query<ProcessingRow>(
        `SELECT id, status, error_code, revision, created_at, updated_at
         FROM learning.processing_jobs
         WHERE learning_profile_id = $1
           AND status IN (
             'queued', 'security_check', 'quality_check', 'recognizing', 'awaiting_confirmation'
           )
         ORDER BY updated_at, id`,
        [scope.learningProfileId],
      );
      for (const row of processing.rows) {
        const awaitingConfirmation = row.status === 'awaiting_confirmation';
        items.push({
          actionTargetId: row.id,
          createdAt: iso(row.updated_at),
          current: true,
          detail: awaitingConfirmation
            ? '识别结果需要确认后才能批改。'
            : `处理进度：${row.status}，可继续查看。`,
          dueAt: null,
          id: `processing:${row.id}`,
          kind: awaitingConfirmation ? 'content_confirmation' : 'resume_learning',
          source: trace({
            aggregateId: row.id,
            aggregateType: 'processing_job',
            at: row.updated_at,
            reason: awaitingConfirmation ? '等待内容确认' : '异步任务仍可继续',
            sourceVersions: { revision: row.revision, status: row.status },
            state: 'pending',
          }),
          title: awaitingConfirmation ? '确认识别内容' : '继续拍照学习',
        });
      }

      const suggestions = await client.query<SuggestedRow>(
        `SELECT id, task_type, status, capability_version_id,
                unavailable_reason, created_at, updated_at
         FROM learning.suggested_assessments
         WHERE learning_profile_id = $1 AND status = 'pending_review'
         ORDER BY updated_at, id`,
        [scope.learningProfileId],
      );
      for (const row of suggestions.rows) {
        items.push({
          actionTargetId: row.id,
          createdAt: iso(row.updated_at),
          current: true,
          detail: '开放题建议需要有权成年人接受后才会成为正式结果。',
          dueAt: null,
          id: `suggestion:${row.id}`,
          kind: 'result_review',
          source: trace({
            aggregateId: row.id,
            aggregateType: 'suggested_assessment',
            at: row.updated_at,
            reason: '建议评价尚未接受',
            sourceVersions: {
              capabilityVersionId: row.capability_version_id,
              status: row.status,
            },
            state: 'pending',
          }),
          title: '等待监护人复核开放题',
        });
      }

      const disputes = await client.query<DisputeRow>(
        `SELECT dispute.id, dispute.assessment_id, dispute.assessment_version_id,
                dispute.target, dispute.review_route, dispute.raised_at
         FROM learning.objective_assessments assessment
         JOIN learning.assessment_disputes dispute ON dispute.id = assessment.open_dispute_id
         WHERE assessment.learning_profile_id = $1
         ORDER BY dispute.raised_at, dispute.id`,
        [scope.learningProfileId],
      );
      for (const row of disputes.rows) {
        items.push({
          actionTargetId: row.id,
          createdAt: iso(row.raised_at),
          current: true,
          detail: '质疑处理完成前，相关结果不会计入错题或学习报告。',
          dueAt: null,
          id: `dispute:${row.id}`,
          kind: 'result_review',
          source: trace({
            aggregateId: row.assessment_id,
            aggregateType: 'objective_assessment',
            at: row.raised_at,
            reason: '评价正在质疑中',
            sourceVersions: {
              assessmentVersionId: row.assessment_version_id,
              disputeId: row.id,
            },
            state: 'disputed',
          }),
          title: '查看批改质疑进度',
        });
      }

      const reviews = await client.query<ReviewRow>(
        `SELECT card.id, card.version, card.schedule, card.source_snapshot,
                card.created_at, (card.schedule ->> 'dueAt')::timestamptz AS due_at
         FROM learning.review_cards card
         JOIN learning.review_card_requests request ON request.id = card.request_id
         JOIN learning.wrong_items item ON item.id = card.wrong_item_id
         WHERE card.learning_profile_id = $1
           AND card.status = 'active'
           AND request.status = 'ready'
           AND request.current_card_id = card.id
           AND item.state_revision = (card.source_snapshot ->> 'wrongItemStateRevision')::integer
           AND item.theme_id = card.source_snapshot ->> 'themeId'
           AND (card.schedule ->> 'dueAt')::timestamptz <= $2::timestamptz
           AND learning.lock_current_wrong_item(item)
         ORDER BY due_at, card.id`,
        [scope.learningProfileId, asOf],
      );
      for (const row of reviews.rows) {
        const source = json<Record<string, ReportingJsonValue>>(row.source_snapshot);
        items.push({
          actionTargetId: row.id,
          createdAt: iso(row.created_at),
          current: true,
          detail: '这张已检查的 AI 变式复习卡已经到期。',
          dueAt: iso(row.due_at),
          id: `review:${row.id}`,
          kind: 'due_review',
          source: trace({
            aggregateId: row.id,
            aggregateType: 'review_card',
            at: row.created_at,
            reason: '复习卡来源和版本仍有效',
            sourceVersions: { ...source, reviewCardVersion: row.version },
            state: 'accepted_current',
          }),
          title: '到期复习卡',
        });
      }

      const wrongItems = await client.query<WrongItemRow>(
        `SELECT item.id, item.assessment_snapshot, item.classification, item.theme_id,
                item.status, item.first_incorrect_at, item.state_revision,
                item.created_at
         FROM learning.wrong_items item
         JOIN learning.wrong_item_theme_mastery mastery
           ON mastery.learning_profile_id = item.learning_profile_id
          AND mastery.theme_id = item.theme_id
         WHERE item.learning_profile_id = $1
           AND mastery.status = 'active'
           AND learning.lock_current_wrong_item(item)
         ORDER BY item.first_incorrect_at, item.id`,
        [scope.learningProfileId],
      );
      for (const row of wrongItems.rows) {
        const classificationValue = classification(row.classification);
        if (classificationValue.status === 'pending') continue;
        const isCorrection = row.status === 'pending_correction';
        items.push({
          actionTargetId: row.id,
          createdAt: iso(row.first_incorrect_at),
          current: true,
          detail: `${classificationValue.unitName ?? '当前单元'} · ${
            classificationValue.knowledgePointName ?? '待巩固知识点'
          }`,
          dueAt: null,
          id: `wrong-item:${row.id}`,
          kind: isCorrection ? 'wrong_item_correction' : 'variation_practice',
          source: trace({
            aggregateId: row.id,
            aggregateType: 'wrong_item',
            at: row.created_at,
            reason: '错题来源和评价版本仍有效',
            sourceVersions: {
              assessmentVersionId:
                json<Record<string, ReportingJsonValue>>(row.assessment_snapshot)
                  .assessmentVersionId ?? null,
              stateRevision: row.state_revision,
              themeId: row.theme_id,
            },
            state: 'accepted_current',
          }),
          title: isCorrection ? '订正错题' : '完成变式巩固',
        });
      }
      return items;
    });
  }

  async readGuardianTodoCandidates(scope: ReportingScope) {
    return this.#withScope(scope, async (client) => {
      const items: GuardianTodoCandidate[] = [];
      const consentResult = await client.query<{ kind: string; status: string; updated_at: Date }>(
        `SELECT kind, status, updated_at
         FROM learning.family_consents
         WHERE family_space_id = $1`,
        [scope.familySpaceId],
      );
      const consentByKind = new Map(consentResult.rows.map((row) => [row.kind, row]));
      for (const kind of CONSENT_KINDS) {
        if (consentByKind.has(kind)) continue;
        items.push({
          actionTargetId: kind,
          createdAt: new Date(0).toISOString(),
          current: true,
          detail: `${CONSENT_LABELS[kind]}尚未作出分项授权决定。`,
          id: `authorization:${kind}`,
          kind: 'authorization',
          source: {
            aggregateId: scope.familySpaceId,
            aggregateType: 'family_consent',
            authorityState: 'pending',
            history: [],
            sourceVersions: { consentKind: kind, statementVersion: 'family-consent-v1' },
          },
          title: `决定${CONSENT_LABELS[kind]}授权`,
        });
      }

      const suggestions = await client.query<SuggestedRow>(
        `SELECT id, task_type, status, capability_version_id,
                unavailable_reason, created_at, updated_at
         FROM learning.suggested_assessments
         WHERE learning_profile_id = $1 AND status = 'pending_review'
         ORDER BY updated_at, id`,
        [scope.learningProfileId],
      );
      for (const row of suggestions.rows) {
        items.push({
          actionTargetId: row.id,
          createdAt: iso(row.updated_at),
          current: true,
          detail: `${row.task_type} 建议评价尚未接受，不计入正式进展。`,
          id: `suggestion:${row.id}`,
          kind: 'open_assessment_review',
          source: trace({
            aggregateId: row.id,
            aggregateType: 'suggested_assessment',
            at: row.updated_at,
            reason: '建议评价尚未接受',
            sourceVersions: {
              capabilityVersionId: row.capability_version_id,
              status: row.status,
            },
            state: 'pending',
          }),
          title: '复核开放题建议',
        });
      }

      const disputes = await client.query<DisputeRow>(
        `SELECT dispute.id, dispute.assessment_id, dispute.assessment_version_id,
                dispute.target, dispute.review_route, dispute.raised_at
         FROM learning.objective_assessments assessment
         JOIN learning.assessment_disputes dispute ON dispute.id = assessment.open_dispute_id
         WHERE assessment.learning_profile_id = $1
         ORDER BY dispute.raised_at, dispute.id`,
        [scope.learningProfileId],
      );
      for (const row of disputes.rows) {
        items.push({
          actionTargetId: row.id,
          createdAt: iso(row.raised_at),
          current: true,
          detail:
            row.review_route === 'guardian'
              ? '请核对原题或作答修正。'
              : '正在等待专业复核，当前结果不会计入报告。',
          id: `dispute:${row.id}`,
          kind: 'dispute',
          source: trace({
            aggregateId: row.assessment_id,
            aggregateType: 'objective_assessment',
            at: row.raised_at,
            reason: '评价正在质疑中',
            sourceVersions: {
              assessmentVersionId: row.assessment_version_id,
              disputeId: row.id,
              reviewRoute: row.review_route,
            },
            state: 'disputed',
          }),
          title: row.review_route === 'guardian' ? '处理批改质疑' : '查看专业复核进度',
        });
      }

      const anomalies = await client.query<{
        aggregate_type: string;
        created_at: Date;
        detail: string;
        id: string;
        reason: string;
        version: string | number | null;
      }>(
        `SELECT 'processing_job'::text AS aggregate_type, id, updated_at AS created_at,
                COALESCE(error_code, 'UNKNOWN') AS reason,
                '拍照处理未完成，请查看失败原因或重试。'::text AS detail,
                revision AS version
         FROM learning.processing_jobs
         WHERE learning_profile_id = $1 AND status = 'failed'
         UNION ALL
         SELECT 'suggested_assessment', id, updated_at,
                COALESCE(unavailable_reason, 'UNKNOWN'),
                '建议评价暂不可用，请检查来源、授权或能力状态。', state_revision
         FROM learning.suggested_assessments
         WHERE learning_profile_id = $1 AND status = 'unavailable'
         UNION ALL
         SELECT 'review_card_request', id, updated_at,
                COALESCE(unavailable_reason, 'UNKNOWN'),
                '复习卡暂不可用，来源变化时主题已安全重开。', state_revision
         FROM learning.review_card_requests
         WHERE learning_profile_id = $1 AND status = 'unavailable'
         UNION ALL
         SELECT 'objective_assessment', assessment.id, version.created_at,
                COALESCE(version.decision ->> 'reasonCode', 'UNGRADABLE'),
                '当前题目暂无法可靠批改，未计入正式学习报告。', version.revision
         FROM learning.objective_assessments assessment
         JOIN learning.objective_assessment_versions version
           ON version.id = assessment.current_version_id
         WHERE assessment.learning_profile_id = $1
           AND assessment.open_dispute_id IS NULL
           AND version.decision ->> 'outcome' = 'ungradable'`,
        [scope.learningProfileId],
      );
      for (const row of anomalies.rows) {
        items.push({
          actionTargetId: row.id,
          createdAt: iso(row.created_at),
          current: true,
          detail: row.detail,
          id: `anomaly:${row.aggregate_type}:${row.id}`,
          kind: 'anomaly',
          source: trace({
            aggregateId: row.id,
            aggregateType: row.aggregate_type,
            at: row.created_at,
            reason: row.reason,
            sourceVersions: { reason: row.reason, version: row.version },
            state: 'invalidated',
          }),
          title: '查看异常处理',
        });
      }
      return sortByCreatedAt(items);
    });
  }

  async readLearningReportFacts(scope: ReportingScope, window: { from: string; to: string }) {
    return this.#withScope(scope, async (client) => {
      const evidenceResult = await client.query<EvidenceRow>(
        `SELECT evidence.id, evidence.theme_id, evidence.cycle,
                evidence.outcome, evidence.qualification, evidence.learning_date,
                evidence.source_kind, evidence.source_reference_id,
                evidence.source_versions, evidence.occurred_at,
                item.id AS wrong_item_id, item.classification,
                CASE
                  WHEN item.classification ->> 'status' = 'pending' THEN 'pending'
                  WHEN assessment.open_dispute_id IS NOT NULL THEN 'disputed'
                  WHEN assessment.current_version_id <> item.assessment_version_id THEN 'expired'
                  WHEN learning.lock_current_wrong_item(item) THEN 'accepted_current'
                  ELSE 'invalidated'
                END AS authority_state,
                GREATEST(item.updated_at, evidence.recorded_at) AS state_changed_at
         FROM learning.learning_evidence evidence
         JOIN learning.wrong_items item ON item.id = evidence.wrong_item_id
         JOIN learning.objective_assessments assessment ON assessment.id = item.assessment_id
         WHERE evidence.learning_profile_id = $1
           AND evidence.occurred_at >= $2::timestamptz
           AND evidence.occurred_at <= $3::timestamptz
         ORDER BY evidence.occurred_at, evidence.id`,
        [scope.learningProfileId, window.from, window.to],
      );
      const evidence: LearningEvidenceReportFact[] = evidenceResult.rows.map((row) => {
        const grouping = classification(row.classification);
        return {
          coursePathName: null,
          id: row.id,
          knowledgePointName: grouping.knowledgePointName,
          learningDate:
            typeof row.learning_date === 'string'
              ? row.learning_date
              : row.learning_date.toISOString().slice(0, 10),
          occurredAt: iso(row.occurred_at),
          outcome: row.outcome,
          qualification: row.qualification,
          source: trace({
            aggregateId: row.wrong_item_id,
            aggregateType: 'wrong_item',
            at: row.occurred_at,
            history: evidenceHistory(row),
            reason: '学习证据来源状态',
            sourceVersions: {
              ...json<Record<string, ReportingJsonValue>>(row.source_versions),
              cycle: row.cycle,
              learningEvidenceId: row.id,
              sourceKind: row.source_kind,
              sourceReferenceId: row.source_reference_id,
              wrongItemId: row.wrong_item_id,
            },
            state: row.authority_state,
          }),
          subject: grouping.subject,
          themeId: row.theme_id,
          unitName: grouping.unitName,
        };
      });

      const themeResult = await client.query<ThemeRow>(
        `SELECT mastery.theme_id, mastery.status, mastery.cycle,
                mastery.mastered_at, mastery.state_revision, item.classification,
                CASE
                  WHEN item.classification ->> 'status' = 'pending' THEN 'pending'
                  WHEN assessment.open_dispute_id IS NOT NULL THEN 'disputed'
                  WHEN assessment.current_version_id <> item.assessment_version_id THEN 'expired'
                  WHEN learning.lock_current_wrong_item(item) THEN 'accepted_current'
                  ELSE 'invalidated'
                END AS authority_state,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'fromStatus', transition.from_status,
                    'toStatus', transition.to_status,
                    'reason', transition.reason,
                    'occurredAt', transition.occurred_at
                  ) ORDER BY transition.occurred_at, transition.id)
                  FROM learning.theme_mastery_transitions transition
                  WHERE transition.learning_profile_id = mastery.learning_profile_id
                    AND transition.theme_id = mastery.theme_id
                ), '[]'::jsonb) AS transitions
         FROM learning.wrong_item_theme_mastery mastery
         JOIN LATERAL (
           SELECT candidate.*
           FROM learning.wrong_items candidate
           WHERE candidate.learning_profile_id = mastery.learning_profile_id
             AND candidate.theme_id = mastery.theme_id
           ORDER BY candidate.updated_at DESC, candidate.id
           LIMIT 1
         ) item ON true
         JOIN learning.objective_assessments assessment ON assessment.id = item.assessment_id
         WHERE mastery.learning_profile_id = $1
         ORDER BY mastery.theme_id`,
        [scope.learningProfileId],
      );
      const themeStates: ThemeStateReportFact[] = themeResult.rows.map((row) => {
        const grouping = classification(row.classification);
        const history = masteryHistory(row.transitions);
        return {
          cycle: row.cycle,
          knowledgePointName: grouping.knowledgePointName,
          masteredAt: row.mastered_at ? iso(row.mastered_at) : null,
          source: trace({
            aggregateId: row.theme_id,
            aggregateType: 'wrong_item_theme',
            at: row.mastered_at ?? new Date(history.at(-1)?.at ?? window.to),
            history,
            reason: '错题主题当前状态',
            sourceVersions: {
              cycle: row.cycle,
              policyVersion: 'wrong-item-theme-mastery-v1',
              stateRevision: row.state_revision,
            },
            state: row.authority_state,
          }),
          status: row.status,
          subject: grouping.subject,
          themeId: row.theme_id,
          unitName: grouping.unitName,
        };
      });

      const changeResult = await client.query<ChangeRow>(
        `SELECT transition.id, transition.theme_id, transition.cycle,
                transition.kind, transition.reason, transition.evidence_ids,
                transition.occurred_at, item.classification,
                CASE
                  WHEN item.classification ->> 'status' = 'pending' THEN 'pending'
                  WHEN assessment.open_dispute_id IS NOT NULL THEN 'disputed'
                  WHEN assessment.current_version_id <> item.assessment_version_id THEN 'expired'
                  WHEN learning.lock_current_wrong_item(item) THEN 'accepted_current'
                  ELSE 'invalidated'
                END AS authority_state,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'fromStatus', history.from_status,
                    'toStatus', history.to_status,
                    'reason', history.reason,
                    'occurredAt', history.occurred_at
                  ) ORDER BY history.occurred_at, history.id)
                  FROM learning.theme_mastery_transitions history
                  WHERE history.learning_profile_id = transition.learning_profile_id
                    AND history.theme_id = transition.theme_id
                ), '[]'::jsonb) AS transitions
         FROM learning.theme_mastery_transitions transition
         JOIN LATERAL (
           SELECT candidate.*
           FROM learning.wrong_items candidate
           WHERE candidate.learning_profile_id = transition.learning_profile_id
             AND candidate.theme_id = transition.theme_id
           ORDER BY candidate.updated_at DESC, candidate.id
           LIMIT 1
         ) item ON true
         JOIN learning.objective_assessments assessment ON assessment.id = item.assessment_id
         WHERE transition.learning_profile_id = $1
           AND transition.occurred_at >= $2::timestamptz
           AND transition.occurred_at <= $3::timestamptz
         ORDER BY transition.occurred_at, transition.id`,
        [scope.learningProfileId, window.from, window.to],
      );
      const wrongItemChanges: WrongItemChangeReportFact[] = changeResult.rows.map((row) => {
        const grouping = classification(row.classification);
        return {
          id: row.id,
          kind:
            row.kind === 'cycle_started'
              ? 'opened'
              : row.kind === 'mastered'
                ? 'mastered'
                : 'reopened',
          knowledgePointName: grouping.knowledgePointName,
          occurredAt: iso(row.occurred_at),
          source: trace({
            aggregateId: row.theme_id,
            aggregateType: 'wrong_item_theme',
            at: row.occurred_at,
            history: masteryHistory(row.transitions),
            reason: row.reason,
            sourceVersions: {
              cycle: row.cycle,
              evidenceIds: row.evidence_ids,
              transitionId: row.id,
            },
            state: row.authority_state,
          }),
          subject: grouping.subject,
          themeId: row.theme_id,
          unitName: grouping.unitName,
        };
      });

      const exclusionResult = await client.query<SuggestedRow>(
        `SELECT id, task_type, status, capability_version_id,
                unavailable_reason, created_at, updated_at
         FROM learning.suggested_assessments
         WHERE learning_profile_id = $1
           AND status <> 'accepted'
           AND updated_at >= $2::timestamptz
           AND updated_at <= $3::timestamptz
         ORDER BY updated_at, id`,
        [scope.learningProfileId, window.from, window.to],
      );
      const exclusions: ExcludedReportFact[] = exclusionResult.rows.map((row) => {
        const pending = ['queued', 'generating', 'pending_review'].includes(row.status);
        return {
          id: row.id,
          reason: pending
            ? '开放题建议尚未接受'
            : `开放题建议未形成正式结果：${row.unavailable_reason ?? row.status}`,
          source: trace({
            aggregateId: row.id,
            aggregateType: 'suggested_assessment',
            at: row.updated_at,
            reason: pending ? '建议评价尚未接受' : '建议评价未形成正式结果',
            sourceVersions: {
              capabilityVersionId: row.capability_version_id,
              status: row.status,
            },
            state: pending ? 'pending' : 'invalidated',
          }),
          subject: null,
        };
      });
      return { evidence, exclusions, themeStates, wrongItemChanges };
    });
  }

  async #withScope<Value>(
    scope: ReportingScope,
    operation: (client: PoolClient) => Promise<Value>,
  ): Promise<Value> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE rhea_reporting_app');
      await client.query('SET LOCAL search_path TO pg_catalog, learning');
      await client.query(`SELECT set_config('rhea.family_space_id', $1, true)`, [
        scope.familySpaceId,
      ]);
      await client.query(`SELECT set_config('rhea.learning_profile_id', $1, true)`, [
        scope.learningProfileId,
      ]);
      const value = await operation(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createPostgresReportingStore(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  return { pool, store: new PostgresReportingStore(pool) };
}
