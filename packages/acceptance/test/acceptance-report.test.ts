import { describe, expect, it } from 'vitest';

import {
  buildAcceptanceReport,
  type AcceptanceEvidence,
  type AcceptanceEvidenceKey,
} from '../src/index.js';

const development: AcceptanceEvidenceKey[] = [
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
const pilot: AcceptanceEvidenceKey[] = [
  'quality_ai_ocr',
  'child_safety',
  'performance_capacity',
  'disaster_recovery',
];

function passed(key: AcceptanceEvidenceKey): AcceptanceEvidence {
  return {
    capturedAt: '2026-09-13T08:00:00.000Z',
    details: key,
    key,
    owner: 'owner',
    reference: `evidence://${key}`,
    status: 'passed',
  };
}

describe('buildAcceptanceReport', () => {
  it('separates development completion from family-pilot readiness', () => {
    const report = buildAcceptanceReport(development.map(passed), {
      deadlines: {},
      generatedAt: '2026-09-13T08:00:00.000Z',
    });
    expect(report).toMatchObject({
      conclusion: 'development_complete_pilot_blocked',
      developmentComplete: true,
      familyPilotReady: false,
      missingForPilot: expect.arrayContaining(pilot),
    });
  });

  it('always blocks public release when the Shanghai package is unsigned', () => {
    const evidence = [...development, ...pilot].map(passed);
    evidence.push({
      capturedAt: '',
      details: 'unsigned',
      key: 'shanghai_compliance_package',
      owner: 'compliance-owner',
      reference: 'compliance/shanghai-release-checklist.md',
      status: 'not_signed',
    });
    const report = buildAcceptanceReport(evidence, {
      deadlines: { shanghai_compliance_package: '公开发布前' },
      generatedAt: '2026-09-13T08:00:00.000Z',
    });
    expect(report).toMatchObject({
      conclusion: 'family_pilot_ready',
      familyPilotReady: true,
      publicRelease: { allowed: false },
    });
    expect(report.publicRelease.reason).toContain('禁止公开发布');
  });
});
