import type {
  GamificationAuthorityState,
  GamificationEvent,
  GamificationScope,
} from './gamification-types.js';

export interface GamificationStore {
  listEvents(scope: GamificationScope): Promise<GamificationEvent[]>;
  recordEvent(event: GamificationEvent): Promise<'conflict' | 'recorded' | 'replayed'>;
  updateAuthority(
    input: GamificationScope & {
      authorityState: GamificationAuthorityState;
      eventKey: string;
      sourceVersion: string;
    },
  ): Promise<'not_found' | 'updated'>;
}
