import { describe, expect, it, vi } from 'vitest';

import { startChallengeReportClassifier } from '../src/challenge-report-classifier.js';
import { createWorkerSafetyEscalation } from '../src/create-safety-escalation.js';

describe('challenge report classifier relay', () => {
  it('keeps the domain worker outside safety credentials and roles', async () => {
    const configured = createWorkerSafetyEscalation(
      { DATABASE_URL: 'postgresql://domain.invalid/rhea', NODE_ENV: 'production' },
      'disabled',
    );
    expect(configured.shutdownResources).toEqual([]);
    await expect(configured.processChallengeReportClassifications()).resolves.toEqual({
      claimed: 0,
      failed: 0,
      processed: 0,
    });
  });

  it('keeps polling after a transient classification failure', async () => {
    let resolveSecond!: () => void;
    const secondRun = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const errors: string[] = [];
    const processBatch = vi
      .fn<() => Promise<{ claimed: number; failed: number; processed: number }>>()
      .mockResolvedValueOnce({ claimed: 1, failed: 1, processed: 0 })
      .mockImplementationOnce(async () => {
        resolveSecond();
        return { claimed: 1, failed: 0, processed: 1 };
      })
      .mockResolvedValue({ claimed: 0, failed: 0, processed: 0 });
    const relay = startChallengeReportClassifier(processBatch, 1, {
      error: (message) => errors.push(String(message)),
    });
    await secondRun;
    await relay.close();
    expect(processBatch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(errors[0]!)).toMatchObject({
      alert: true,
      claimed: 1,
      consecutiveFailures: 1,
      event: 'challenge_report_classification_failed',
      failed: 1,
      processed: 0,
      requiresOperatorAction: true,
      severity: 'critical',
    });
  });
});
