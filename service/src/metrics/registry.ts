import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/** Outcome labels of portal calls (SPEC §7), also the `reason` of retries. */
export const OUTCOMES = [
  'success',
  'rate_limited',
  'unavailable',
  'timeout',
  'network_error',
  'client_error',
  'unauthorized',
  'server_error',
  'unexpected_status',
] as const;
export type OutcomeLabel = (typeof OUTCOMES)[number];
export type RetryReason = Exclude<OutcomeLabel, 'success' | 'client_error'>;
export const RETRY_REASONS = OUTCOMES.filter(
  (o): o is RetryReason => o !== 'success' && o !== 'client_error',
);
/** Every code POST /updates can answer without accepting (SPEC §6). */
export const REJECTION_CODES = [
  'INVALID_BODY',
  'INVALID_DATE',
  'RANGE_TOO_LARGE',
  'INVALID_HEADER',
  'IDEMPOTENCY_KEY_REUSED',
  'UNSUPPORTED_MEDIA_TYPE',
  'PAYLOAD_TOO_LARGE',
  'UNAVAILABLE',
] as const;
export type RejectionCode = (typeof REJECTION_CODES)[number];

/** Every instrument the service updates; one set per app instance (own registry). */
export type Metrics = {
  readonly registry: Registry;
  readonly portalRequests: Counter<'outcome'>;
  readonly portalRequestDuration: Histogram<'outcome'>;
  readonly retries: Counter<'reason'>;
  readonly tasksFinished: Counter<'result'>;
  readonly updateLag: Histogram;
  readonly sendsDeferred: Counter;
  readonly updatesAccepted: Counter;
  readonly updatesRejected: Counter<'code'>;
  readonly limiterPausedSeconds: Gauge;
  readonly limiterWindowStarts: Gauge;
  readonly workerActive: Gauge;
  /** Typed entry points: prom-client checks label *names* but not *values*, so the documented
   * outcomes are enforced here, at compile time. */
  readonly recordPortalCall: (outcome: OutcomeLabel, durationSeconds: number) => void;
  readonly recordRetry: (reason: RetryReason) => void;
  readonly recordRejection: (code: RejectionCode) => void;
  readonly staleResults: Counter;
};

/**
 * prom-client rejects an undeclared label *name* at runtime, but accepts any label *value*; the
 * documented values are enforced by the typed `record*` functions (checked by `tsc`).
 */
export function createMetrics(): Metrics {
  // Never the global default registry: two app instances (or tests) must not share counters.
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const registers = [registry];
  const instruments = {
    registry,
    portalRequests: new Counter({
      name: 'portal_requests_total',
      help: 'Portal Sol calls by outcome (success, rate_limited, unavailable, timeout, …).',
      labelNames: ['outcome'],
      registers,
    }),
    portalRequestDuration: new Histogram({
      name: 'portal_request_duration_seconds',
      help: 'Portal Sol call latency by outcome.',
      labelNames: ['outcome'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers,
    }),
    retries: new Counter({
      name: 'sync_retries_total',
      help: 'Retries scheduled, by the transient outcome that caused them.',
      labelNames: ['reason'],
      registers,
    }),
    tasksFinished: new Counter({
      name: 'sync_tasks_finished_total',
      help: 'Tasks finished: done, or failed (a permanent failure also fails its siblings).',
      labelNames: ['result'],
      registers,
    }),
    updateLag: new Histogram({
      name: 'sync_update_lag_seconds',
      help: 'From acceptance to the last chunk done, once per synced update.',
      buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600],
      registers,
    }),
    sendsDeferred: new Counter({
      name: 'sync_sends_deferred_total',
      help: 'Sends skipped because the global pause started between claim and send.',
      registers,
    }),
    updatesAccepted: new Counter({
      name: 'updates_accepted_total',
      help: 'Updates accepted by POST /updates (idempotent replays excluded).',
      registers,
    }),
    updatesRejected: new Counter({
      name: 'updates_rejected_total',
      help: 'POST /updates rejected, by error code.',
      labelNames: ['code'],
      registers,
    }),
    limiterPausedSeconds: new Gauge({
      name: 'portal_rate_limiter_paused_seconds',
      help: 'What remains of the global pause after a 429.',
      registers,
    }),
    limiterWindowStarts: new Gauge({
      name: 'portal_rate_limiter_window_starts',
      help: 'Request starts in the current 60 s window.',
      registers,
    }),
    workerActive: new Gauge({
      name: 'sync_worker_active',
      help: '1 on the instance holding the single-worker lock, 0 otherwise.',
      registers,
    }),
  };
  return {
    ...instruments,
    recordPortalCall: (outcome, durationSeconds) => {
      instruments.portalRequests.inc({ outcome });
      instruments.portalRequestDuration.observe({ outcome }, durationSeconds);
    },
    recordRetry: (reason) => instruments.retries.inc({ reason }),
    recordRejection: (code) => instruments.updatesRejected.inc({ code }),
    staleResults: new Counter({
      name: 'sync_stale_results_total',
      help: 'Attempt results discarded because the lease had been lost (fencing).',
      registers,
    }),
  };
}
