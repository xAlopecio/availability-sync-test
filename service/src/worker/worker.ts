import type pg from 'pg';
import type { RetryPolicy } from '../domain/retry/backoff.ts';
import type { ClaimedTask } from '../db/queue.ts';
import type { PortalClient } from '../portal/client.ts';
import type { SlidingWindowRateLimiter } from '../portal/rate-limiter.ts';
import type { AttemptAction, ObservedCall } from './decide.ts';

/** The subset of pino's API the worker logs with (Fastify's `app.log` satisfies it). */
export type WorkerLog = {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

export type AttemptRecord = {
  readonly task: ClaimedTask;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly call: ObservedCall;
  readonly action: AttemptAction;
};

export type WorkerOptions = {
  readonly pool: pg.Pool;
  readonly client: PortalClient;
  readonly limiter: SlidingWindowRateLimiter;
  readonly log: WorkerLog;
  readonly concurrency: number;
  readonly leaseMs: number;
  readonly pollMs: number;
  readonly timeoutMs: number;
  readonly retry: RetryPolicy;
  readonly random?: () => number;
  /** Test hook: called after every attempt. */
  readonly onAttempt?: (record: AttemptRecord) => void;
};

export type Worker = {
  start(): void;
  /** Stops claiming, aborts waits, lets in-flight attempts finish and store their outcome. */
  stop(): Promise<void>;
};

/** SPEC D5: N slots, each acquire a permit → claim → send → decide → apply. */
export function createWorker(_options: WorkerOptions): Worker {
  throw new Error('not implemented');
}
