import type pg from 'pg';
import type { RetryPolicy } from '../domain/retry/backoff.ts';
import {
  claimTask,
  completeTask,
  failTask,
  rescheduleTask,
  type ClaimedTask,
} from '../db/queue.ts';
import type { PortalClient } from '../portal/client.ts';
import type { SlidingWindowRateLimiter } from '../portal/rate-limiter.ts';
import { decideAttempt, type AttemptAction, type ObservedCall } from './decide.ts';
import { sleepUnlessAborted } from './sleep.ts';

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
  /** D9: after a timeout, how long overlapping tasks of that accommodation stay unclaimable. */
  readonly timeoutSettleMs?: number;
  readonly retry: RetryPolicy;
  readonly random?: () => number;
  /** Test hook: called right after a task is claimed, before it is sent. */
  readonly onClaimed?: (task: ClaimedTask) => void;
  /** Test hook: called after every attempt. */
  readonly onAttempt?: (record: AttemptRecord) => void;
};

export type Worker = {
  start(): void;
  /** Stops claiming, aborts waits, lets in-flight attempts finish and store their outcome. */
  stop(): Promise<void>;
};

/** SPEC D5: N slots, each acquire a permit → claim → send → decide → apply. */
export function createWorker(options: WorkerOptions): Worker {
  const { pool, client, limiter, log, concurrency, leaseMs, pollMs, timeoutMs, retry } = options;
  const random = options.random ?? Math.random;
  const stopping = new AbortController();
  let slots: Promise<void>[] = [];

  const pause = (ms: number) => sleepUnlessAborted(ms, stopping.signal);

  async function runSlot(slot: number): Promise<void> {
    while (!stopping.signal.aborted) {
      let permit: number;
      try {
        permit = await limiter.acquire({ signal: stopping.signal });
      } catch {
        return; // aborted by stop()
      }
      let task: ClaimedTask | null;
      try {
        task = await claimTask(pool, {
          leaseMs,
          ...(options.timeoutSettleMs === undefined ? {} : { settleMs: options.timeoutSettleMs }),
        });
      } catch (error) {
        limiter.release(permit);
        log.warn(
          { err: error, slot },
          'worker could not claim a task; retrying after the poll interval',
        );
        await pause(pollMs);
        continue;
      }
      if (task === null) {
        // Nothing to send: give this slot's permit back so an idle worker uses no quota (SPEC D5).
        limiter.release(permit);
        await pause(pollMs);
        continue;
      }
      // Not aborted by stop(): an in-flight attempt finishes and its outcome is stored.
      try {
        await attempt(task);
      } catch (error) {
        // Anything unexpected (a bug, a client that throws): never an unhandled rejection that
        // kills the process. The lease expires and the task is retried (idempotent PUT).
        log.error(
          { err: error, slot, taskId: task.taskId, accommodationId: task.accommodationId },
          'unexpected error in a worker slot; the task will be retried when its lease expires',
        );
        await pause(pollMs);
      }
    }
  }

  async function attempt(task: ClaimedTask): Promise<void> {
    options.onClaimed?.(task);
    // Another slot may have hit a 429 while this one was claiming: its permit predates the pause,
    // but nothing may reach the portal before Retry-After (SPEC D5, AC6).
    const pausedMs = limiter.pausedRemaining();
    if (pausedMs > 0) {
      await rescheduleTask(pool, task, {
        delayMs: pausedMs,
        error: 'deferred: rate-limit pause',
        httpStatus: null,
      });
      log.info(
        { taskId: task.taskId, accommodationId: task.accommodationId, pausedMs },
        'send deferred: the rate limiter is paused',
      );
      return;
    }
    const startedAt = Date.now();
    const call = await client.putAvailability(task.accommodationId, {
      from: task.from,
      to: task.to,
      available: task.available,
      pricePerNight: task.pricePerNight,
    });
    const endedAt = Date.now();
    const action = decideAttempt({
      attempt: task.attempt,
      call,
      now: endedAt,
      random,
      timeoutMs,
      policy: retry,
    });
    if (action.type === 'reschedule' && action.pauseForMs !== undefined) {
      limiter.pauseFor(action.pauseForMs); // every slot waits, not just this task (SPEC D4)
    }

    let applied: boolean;
    try {
      applied =
        action.type === 'complete'
          ? await completeTask(pool, task, { httpStatus: action.httpStatus })
          : action.type === 'reschedule'
            ? await rescheduleTask(pool, task, {
                delayMs: action.at - endedAt, // applied on the database clock
                error: action.error,
                httpStatus: action.httpStatus,
                timedOut: action.outcome === 'timeout',
              })
            : await failTask(pool, task, { error: action.error, httpStatus: action.httpStatus });
    } catch (error) {
      // The lease expires and the task is retried; re-sending is safe (idempotent PUT).
      log.error(
        { err: error, taskId: task.taskId },
        'could not store the attempt outcome; the lease will expire',
      );
      applied = false;
    }

    const fields = {
      taskId: task.taskId,
      updateId: task.updateId,
      accommodationId: task.accommodationId,
      attempt: task.attempt,
      outcome: action.outcome,
      httpStatus: action.httpStatus,
      durationMs: endedAt - startedAt,
      nextAttemptAt: action.type === 'reschedule' ? new Date(action.at).toISOString() : null,
      ...(action.type === 'complete' ? {} : { error: action.error }),
      ...(applied ? {} : { stale: true }),
    };
    if (action.type === 'complete') log.info(fields, 'portal attempt succeeded');
    else if (action.type === 'fail') log.error(fields, 'portal attempt failed permanently');
    else if (action.logLevel === 'error')
      log.error(fields, 'portal attempt failed; needs attention');
    else log.warn(fields, 'portal attempt failed; retrying');

    options.onAttempt?.({ task, startedAt, endedAt, call, action });
  }

  return {
    start() {
      if (slots.length > 0) return;
      slots = Array.from({ length: concurrency }, (_, slot) => runSlot(slot));
    },
    async stop() {
      stopping.abort();
      await Promise.all(slots);
    },
  };
}
