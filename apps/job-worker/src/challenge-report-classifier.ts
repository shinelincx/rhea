export interface ChallengeReportClassificationBatch {
  claimed: number;
  failed: number;
  processed: number;
}

export function startChallengeReportClassifier(
  processBatch: () => Promise<ChallengeReportClassificationBatch>,
  intervalMs = 1_000,
  logger: Pick<Console, 'error'> = console,
) {
  let active: Promise<void> | null = null;
  let consecutiveFailures = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const poll = () => {
    if (stopped) return;
    active = processBatch()
      .then((batch) => {
        if (batch.failed > 0) {
          consecutiveFailures += 1;
          logger.error(
            JSON.stringify({
              alert: true,
              claimed: batch.claimed,
              consecutiveFailures,
              event: 'challenge_report_classification_failed',
              failed: batch.failed,
              processed: batch.processed,
              requiresOperatorAction: true,
              severity: 'critical',
            }),
          );
        } else if (batch.claimed > 0) {
          consecutiveFailures = 0;
        }
      })
      .catch((error: unknown) => {
        consecutiveFailures += 1;
        logger.error(
          JSON.stringify({
            alert: true,
            consecutiveFailures,
            errorCode: 'CHALLENGE_REPORT_CLASSIFIER_POLL_FAILED',
            event: 'challenge_report_classification_failed',
            message: error instanceof Error ? error.message : 'unknown error',
            requiresOperatorAction: true,
            severity: 'critical',
          }),
        );
      })
      .finally(() => {
        active = null;
        if (!stopped) timer = setTimeout(poll, intervalMs);
      });
  };
  poll();

  return {
    async close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await active;
    },
  };
}
