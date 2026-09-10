import { describe, expect, it } from 'vitest';

import { createConfiguredGeneratedLearningProcessor } from '../src/create-generated-learning-processor.js';

describe('configured generated learning processor', () => {
  it('does not pretend a generation handler exists without persistent authoritative state', () => {
    expect(createConfiguredGeneratedLearningProcessor({})).toEqual({
      handler: undefined,
      shutdownResources: [],
    });
  });
});
