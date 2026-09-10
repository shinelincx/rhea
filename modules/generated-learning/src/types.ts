import type { CurrentLearningBasisReference, Subject } from '@rhea/learning-content';

export type AgeBand = 'lower_primary' | 'middle_primary' | 'upper_primary';
export type GeneratedContentState = 'direct_learning' | 'confirmation_recommended' | 'unavailable';
export type GenerationRequestStatus =
  'canceled' | 'generating' | 'queued' | 'ready' | 'unavailable';
export type GenerationUnavailableReason =
  | 'CAPABILITY_UNAVAILABLE'
  | 'CONSENT_WITHDRAWN'
  | 'GENERATION_CANCELED'
  | 'GENERATION_CHECK_FAILED'
  | 'MODEL_UNAVAILABLE'
  | 'SOURCE_CHANGED'
  | 'SOURCE_UNAVAILABLE';

export interface GeneratedLearningActorReference {
  id: string;
  type: 'guardian' | 'learner';
}

export interface GeneratedLearningCapability {
  adapterVersion: string;
  availability: 'approved' | 'unavailable';
  id: string;
  modelVersion: string;
  policyVersion: string;
  region: string;
  templateVersion: string;
}

export interface GenerationSourceExcerpt {
  kind: 'answer' | 'question' | 'shared_prompt';
  regionId: string;
  text: string;
}

export interface ModelSourceExcerpt {
  kind: GenerationSourceExcerpt['kind'];
  sourceRef: string;
  text: string;
}

export interface GenerationSourceSnapshot {
  ageBand: AgeBand;
  basis: CurrentLearningBasisReference;
  basisHasConflict: boolean;
  classificationRevision: number;
  confirmedContentVersionId: string;
  coursePathName: string | null;
  excerpts: GenerationSourceExcerpt[];
  knowledgePointNames: string[];
  processingJobId: string;
  subject: Subject;
  unitName: string | null;
}

export interface NumericGeneratedRule {
  expected: string;
  kind: 'numeric';
}

export interface AcceptedTextGeneratedRule {
  acceptedAnswers: string[];
  caseSensitive: boolean;
  collapseWhitespace: boolean;
  kind: 'accepted_text';
}

export interface SingleChoiceGeneratedRule {
  correctOption: string;
  kind: 'single_choice';
}

export type GeneratedObjectiveRule =
  AcceptedTextGeneratedRule | NumericGeneratedRule | SingleChoiceGeneratedRule;

export interface GeneratedQuestionCandidate {
  explanationSteps: string[];
  expectedAnswer: string;
  gradingRule: GeneratedObjectiveRule;
  id: string;
  question: string;
}

export interface GeneratedLearningPackCandidate {
  fullExplanation: {
    answer: string;
    steps: string[];
  };
  keyTerms: Array<{ sourceRegionIds: string[]; term: string }>;
  methodHint: string;
  orientationHint: string;
  quiz: GeneratedQuestionCandidate[];
  summary: {
    keyPoints: string[];
    title: string;
  };
  supplementalNotes: string[];
  variations: GeneratedQuestionCandidate[];
}

export interface ModelTask {
  ageBand: AgeBand;
  capability: GeneratedLearningCapability;
  hintPolicy: 'orientation_then_method_then_full_explanation';
  maxQuizItems: 5;
  purpose: 'learning_pack';
  riskLevel: 'medium';
  sourceBasis: Pick<CurrentLearningBasisReference, 'kind'>;
  subject: Subject;
  untrustedSourceExcerpts: ModelSourceExcerpt[];
}

export interface ModelTaskResult {
  candidate: GeneratedLearningPackCandidate;
  externalTraceId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  provider: string;
}

export interface GenerationCheck {
  detail: string;
  kind:
    | 'age_appropriateness'
    | 'answer_leakage'
    | 'consistency'
    | 'safety'
    | 'schema'
    | 'solvability'
    | 'source_coverage';
  passed: boolean;
}

export interface ModelRunRecord {
  attempt: number;
  externalTraceId: string | null;
  finishedAt: string;
  inputTokens: number | null;
  outputTokens: number | null;
  provider: string;
  succeeded: boolean;
}

export interface GeneratedLearningContentVersion {
  capability: GeneratedLearningCapability;
  checks: GenerationCheck[];
  contentState: Exclude<GeneratedContentState, 'unavailable'>;
  createdAt: string;
  id: string;
  pack: GeneratedLearningPackCandidate;
  predecessorId: string | null;
  revision: number;
  source: GenerationSourceSnapshot;
}

export interface StoredGenerationRequest {
  actor: GeneratedLearningActorReference;
  capability: GeneratedLearningCapability;
  consentRevision: number;
  createdAt: string;
  currentVersionId: string | null;
  familySpaceId: string;
  id: string;
  idempotencyKey: string;
  latestChecks: GenerationCheck[];
  learningProfileId: string;
  materialId: string;
  modelRuns: ModelRunRecord[];
  processingLeaseExpiresAt: string | null;
  purpose: 'learning_pack';
  revealedHintLevel: 0 | 1 | 2 | 3;
  requestFingerprint: string;
  source: GenerationSourceSnapshot;
  stateRevision: number;
  status: GenerationRequestStatus;
  unavailableReason: GenerationUnavailableReason | null;
  updatedAt: string;
  versions: GeneratedLearningContentVersion[];
}

export interface GeneratedQuestionView {
  id: string;
  question: string;
}

export interface GeneratedLearningRequestView {
  aiDisclosure: '我是 AI 学习助手，内容由 AI 生成并经过发布前检查。';
  capabilityVersion: GeneratedLearningCapability;
  contentState: GeneratedContentState;
  createdAt: string;
  familySpaceId: string;
  generatedContent: null | {
    fullExplanation: null | { answer: string; steps: string[] };
    keyTerms: Array<{ sourceRegionIds: string[]; term: string }>;
    methodHint: string | null;
    orientationHint: string | null;
    quiz: GeneratedQuestionView[];
    summary: { keyPoints: string[]; title: string };
    supplementalNotes: string[];
    variations: GeneratedQuestionView[];
  };
  id: string;
  learningProfileId: string;
  materialId: string;
  purpose: 'learning_pack';
  revealedHintLevel: 0 | 1 | 2 | 3;
  sourceVersion: {
    basisSelectionVersion: number;
    basisSourceVersionId: string;
    basisValidityEpoch: number;
    classificationRevision: number;
    confirmedContentVersionId: string;
    versionLabel: string;
  };
  status: GenerationRequestStatus;
  unavailableReason: GenerationUnavailableReason | null;
  updatedAt: string;
}
