import { describe, expect, it } from 'vitest';

import {
  generatedLearningSourceKey,
  type GeneratedLearningPackCandidate,
  type GenerationSourceSnapshot,
} from '../src/index.js';
import { hasPrematureAnswerLeakage, verifyDeterministicContent } from '../src/quality.js';

const pack: GeneratedLearningPackCandidate = {
  fullExplanation: { answer: '9', steps: ['36 ÷ 4 = 9。'] },
  keyTerms: [{ sourceRegionIds: ['question-1'], term: '除法' }],
  methodHint: '想一想 4 乘几得到 36。',
  orientationHint: '先找到总数和每组数量。',
  quiz: [
    {
      explanationSteps: ['24 ÷ 4 = 6。'],
      expectedAnswer: '6',
      gradingRule: { expected: '6', kind: 'numeric' },
      id: 'quiz-1',
      question: '24 ÷ 4 = ？',
    },
  ],
  summary: { keyPoints: ['可以用乘法口诀想除法。'], title: '认识除法' },
  supplementalNotes: [],
  variations: [
    {
      explanationSteps: ['32 ÷ 4 = 8。'],
      expectedAnswer: '8',
      gradingRule: { expected: '8', kind: 'numeric' },
      id: 'variation-1',
      question: '32 ÷ 4 = ？',
    },
  ],
};
const source = {
  ageBand: 'middle_primary',
  basis: {
    contentHash: 'a'.repeat(64),
    kind: 'learning_material',
    materialId: 'material-1',
    selectionVersion: 1,
    sourceVersionId: 'source-1',
    validityEpoch: 1,
    versionLabel: '第 1 版',
  },
  basisHasConflict: false,
  classificationRevision: 1,
  confirmedContentVersionId: 'content-1',
  coursePathName: null,
  excerpts: [{ kind: 'question', regionId: 'question-1', text: '计算：36 ÷ 4 =' }],
  knowledgePointNames: [],
  processingJobId: 'job-1',
  subject: 'mathematics',
  unitName: null,
} satisfies GenerationSourceSnapshot;

describe('generated learning deterministic checks', () => {
  it('creates an order-independent source key that changes with classification lineage', () => {
    const reordered: GenerationSourceSnapshot = {
      unitName: source.unitName,
      subject: source.subject,
      processingJobId: source.processingJobId,
      knowledgePointNames: [...source.knowledgePointNames],
      excerpts: source.excerpts.map(({ kind, regionId, text }) => ({ text, regionId, kind })),
      coursePathName: source.coursePathName,
      confirmedContentVersionId: source.confirmedContentVersionId,
      classificationRevision: source.classificationRevision,
      basisHasConflict: source.basisHasConflict,
      basis: {
        versionLabel: source.basis.versionLabel,
        validityEpoch: source.basis.validityEpoch,
        sourceVersionId: source.basis.sourceVersionId,
        selectionVersion: source.basis.selectionVersion,
        materialId: source.basis.materialId,
        kind: source.basis.kind,
        contentHash: source.basis.contentHash,
      },
      ageBand: source.ageBand,
    };

    expect(generatedLearningSourceKey(reordered)).toBe(generatedLearningSourceKey(source));
    expect(generatedLearningSourceKey(source)).toBe(
      [
        'learning_pack',
        'v1',
        source.basis.materialId,
        source.basis.sourceVersionId,
        source.basis.selectionVersion,
        source.basis.validityEpoch,
        source.basis.contentHash,
        source.confirmedContentVersionId,
        source.classificationRevision,
        source.processingJobId,
      ].join(':'),
    );
    expect(
      generatedLearningSourceKey({
        ...source,
        classificationRevision: source.classificationRevision + 1,
      }),
    ).not.toBe(generatedLearningSourceKey(source));
  });

  it('detects answer leakage in every field visible before the full explanation', () => {
    expect(hasPrematureAnswerLeakage(pack)).toBe(false);
    expect(
      hasPrematureAnswerLeakage({
        ...pack,
        summary: { ...pack.summary, keyPoints: ['这道题的答案是 9。'] },
      }),
    ).toBe(true);
    expect(hasPrematureAnswerLeakage({ ...pack, methodHint: '答案是 9。' })).toBe(true);
    expect(
      hasPrematureAnswerLeakage({
        ...pack,
        quiz: [{ ...pack.quiz[0]!, question: '答案为 6 时请选择。' }],
      }),
    ).toBe(true);
    expect(
      hasPrematureAnswerLeakage({
        ...pack,
        supplementalNotes: ['小测答案为 6。'],
      }),
    ).toBe(true);
  });

  it('verifies exact arithmetic and fails conflicting model answers or grading rules', () => {
    expect(verifyDeterministicContent(pack, source)).toBe('verified');
    expect(
      verifyDeterministicContent(
        { ...pack, fullExplanation: { ...pack.fullExplanation, answer: '8' } },
        source,
      ),
    ).toBe('failed');
    expect(
      verifyDeterministicContent(
        {
          ...pack,
          fullExplanation: { ...pack.fullExplanation, steps: ['36 ÷ 4 = 8。'] },
        },
        source,
      ),
    ).toBe('failed');
    expect(
      verifyDeterministicContent(
        {
          ...pack,
          quiz: [
            {
              ...pack.quiz[0]!,
              expectedAnswer: '7',
              gradingRule: { expected: '7', kind: 'numeric' },
            },
          ],
        },
        source,
      ),
    ).toBe('failed');
  });

  it('marks non-deterministic questions for confirmation instead of direct learning', () => {
    expect(
      verifyDeterministicContent(
        { ...pack, quiz: [{ ...pack.quiz[0]!, question: '24 个贴纸每 4 个一组，共几组？' }] },
        source,
      ),
    ).toBe('unverified');
    expect(
      verifyDeterministicContent(pack, {
        ...source,
        excerpts: [
          ...source.excerpts,
          { kind: 'question', regionId: 'question-2', text: '计算：16 ÷ 4 =' },
        ],
      }),
    ).toBe('unverified');
  });
});
