import type { AcceptanceEvidence, AcceptanceEvidenceKey, AcceptanceReport } from './types.js';
const DEVELOPMENT: AcceptanceEvidenceKey[] = [
  'mobile_core_flow',
  'subject_chinese',
  'subject_mathematics',
  'subject_english',
  'subject_science',
  'failure_network_recovery',
  'failure_late_result',
  'failure_dispute',
  'failure_source_invalidation',
  'failure_provider_degradation',
  'erasure',
  'random_challenge_safety',
];
const PILOT: AcceptanceEvidenceKey[] = [
  ...DEVELOPMENT,
  'quality_ai_ocr',
  'child_safety',
  'performance_capacity',
  'disaster_recovery',
];
export function buildAcceptanceReport(
  evidence: AcceptanceEvidence[],
  input: { deadlines: Partial<Record<AcceptanceEvidenceKey, string>>; generatedAt: string },
): AcceptanceReport {
  const map = new Map(evidence.map((item) => [item.key, item]));
  const missing = (keys: AcceptanceEvidenceKey[]) =>
    keys.filter((key) => map.get(key)?.status !== 'passed');
  const missingForDevelopment = missing(DEVELOPMENT);
  const missingForPilot = missing(PILOT);
  const developmentComplete = !missingForDevelopment.length;
  const familyPilotReady = developmentComplete && !missingForPilot.length;
  const compliance = map.get('shanghai_compliance_package');
  return {
    conclusion: familyPilotReady
      ? 'family_pilot_ready'
      : developmentComplete
        ? 'development_complete_pilot_blocked'
        : 'development_incomplete',
    developmentComplete,
    familyPilotReady,
    generatedAt: input.generatedAt,
    missingForDevelopment,
    missingForPilot,
    publicRelease: {
      allowed: false,
      reason:
        compliance?.status === 'passed'
          ? 'V1 policy requires an explicit later public-release decision even after the Shanghai package is signed.'
          : '上海属地 APP/ICP、儿童信息、AI 标识、算法/模型备案与人工处置责任尚未全部签署，禁止公开发布。',
    },
    remainingRisks: evidence
      .filter((item) => item.status !== 'passed')
      .map((item) => ({
        deadline: input.deadlines[item.key] ?? '待产品负责人登记',
        evidenceKey: item.key,
        owner: item.owner,
        status: item.status,
      })),
    reportVersion: 'rhea-v1-acceptance-report-v1',
  };
}
export type { AcceptanceEvidence, AcceptanceEvidenceKey, AcceptanceReport } from './types.js';
