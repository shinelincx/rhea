import type { GamificationStore } from './gamification-store.js';
import type { GamificationEvent } from './gamification-types.js';

function fingerprint(event: GamificationEvent): string {
  return JSON.stringify(event);
}

export class MemoryGamificationStore implements GamificationStore {
  readonly #events = new Map<string, GamificationEvent>();

  async listEvents(scope: { familySpaceId: string; learningProfileId: string }) {
    return [...this.#events.values()]
      .filter(
        (event) =>
          event.familySpaceId === scope.familySpaceId &&
          event.learningProfileId === scope.learningProfileId,
      )
      .map((event) => structuredClone(event));
  }

  async recordEvent(event: GamificationEvent) {
    const key = `${event.learningProfileId}:${event.eventKey}`;
    const existing = this.#events.get(key);
    if (existing) {
      const replayCandidate = ['disputed', 'expired', 'invalidated'].includes(
        existing.authorityState,
      )
        ? { ...existing, authorityState: event.authorityState, sourceVersion: event.sourceVersion }
        : existing;
      return fingerprint(replayCandidate) === fingerprint(event) ? 'replayed' : 'conflict';
    }
    this.#events.set(key, structuredClone(event));
    return 'recorded';
  }

  async updateAuthority(input: {
    authorityState: GamificationEvent['authorityState'];
    eventKey: string;
    familySpaceId: string;
    learningProfileId: string;
    sourceVersion: string;
  }) {
    const key = `${input.learningProfileId}:${input.eventKey}`;
    const event = this.#events.get(key);
    if (!event || event.familySpaceId !== input.familySpaceId) return 'not_found';
    if (
      ['disputed', 'expired', 'invalidated'].includes(event.authorityState) &&
      event.authorityState !== input.authorityState
    ) {
      return 'updated';
    }
    this.#events.set(key, {
      ...event,
      authorityState: input.authorityState,
      sourceVersion: input.sourceVersion,
    });
    return 'updated';
  }
}
