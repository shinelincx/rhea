export type DependencyName = 'database' | 'redis' | 'objectStorage';

export interface DependencyProbe {
  readonly name: DependencyName;
  check(): Promise<void>;
}

export const DEPENDENCY_PROBES = Symbol('DEPENDENCY_PROBES');
