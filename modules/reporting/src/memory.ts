import type { ReportingStore } from './store.js';
import type {
  GuardianTodoCandidate,
  LearningEvidenceReportFact,
  ExcludedReportFact,
  ThemeStateReportFact,
  TodayRouteCandidate,
  WrongItemChangeReportFact,
} from './types.js';

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

export interface MemoryReportingSeed {
  evidence?: LearningEvidenceReportFact[];
  exclusions?: ExcludedReportFact[];
  guardianTodos?: GuardianTodoCandidate[];
  routeCandidates?: TodayRouteCandidate[];
  themeStates?: ThemeStateReportFact[];
  wrongItemChanges?: WrongItemChangeReportFact[];
}

export class MemoryReportingStore implements ReportingStore {
  readonly #seed: Required<MemoryReportingSeed>;

  constructor(seed: MemoryReportingSeed = {}) {
    this.#seed = {
      evidence: seed.evidence ?? [],
      exclusions: seed.exclusions ?? [],
      guardianTodos: seed.guardianTodos ?? [],
      routeCandidates: seed.routeCandidates ?? [],
      themeStates: seed.themeStates ?? [],
      wrongItemChanges: seed.wrongItemChanges ?? [],
    };
  }

  async readGuardianTodoCandidates() {
    return clone(this.#seed.guardianTodos);
  }

  async readLearningReportFacts() {
    return clone({
      evidence: this.#seed.evidence,
      exclusions: this.#seed.exclusions,
      themeStates: this.#seed.themeStates,
      wrongItemChanges: this.#seed.wrongItemChanges,
    });
  }

  async readTodayRouteCandidates() {
    return clone(this.#seed.routeCandidates);
  }
}
