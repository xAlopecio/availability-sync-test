import type { Counter, Gauge, Histogram, Registry } from 'prom-client';

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
};

export function createMetrics(): Metrics {
  throw new Error('not implemented');
}
