import type pg from 'pg';
import type { RetryPolicy } from '../domain/retry/backoff.ts';
import {
  claimTask,
  completeTask,
  failTask,
  rescheduleTask,
  syncedUpdateLagMs,
  type ClaimedTask,
} from '../db/queue.ts';
import type { PortalClient } from '../portal/client.ts';
import type { SlidingWindowRateLimiter } from '../portal/rate-limiter.ts';
import { decideAttempt, type AttemptAction, type ObservedCall } from './decide.ts';
import { sleepUnlessAborted } from './sleep.ts';
import type { Metrics } from '../metrics/registry.ts';

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
  /** Standby instances retry the single-worker lock this often (SPEC D5). Default 5 s. */
  readonly leaderRetryMs?: number;
  /** The service's metrics (SPEC §7); none if not given (tests). */
  readonly metrics?: Metrics;
  /** Test hook: called right after a task is claimed, before it is sent. */
  readonly onClaimed?: (task: ClaimedTask) => void;
  /** Test hook: called after every attempt. */
  readonly onAttempt?: (record: AttemptRecord) => void;
};

export type Worker = {
  start(): void;
  /** Stops claiming, aborts waits, lets in-flight attempts finish and store their outcome. */
  stop(): Promise<void>;
  /** `active` while holding the single-worker lock (SPEC D5), otherwise `standby`. */
  status(): 'active' | 'standby';
};

/** SPEC D5: N slots, each acquire a permit → claim → send → decide → apply. */
export function createWorker(options: WorkerOptions): Worker {
  const { pool, client, limiter, log, concurrency, leaseMs, pollMs, timeoutMs, retry } = options;
  const random = options.random ?? Math.random;
  const stopping = new AbortController();
  let slots: Promise<void>[] = [];

  const pause = (ms: number, signal: AbortSignal = stopping.signal) =>
    sleepUnlessAborted(ms, signal);

  async function runSlot(slot: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let permit: number;
      try {
        permit = await limiter.acquire({ signal });
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
        await pause(pollMs, signal);
        continue;
      }
      if (task === null) {
        // Nothing to send: give this slot's permit back so an idle worker uses no quota (SPEC D5).
        limiter.release(permit);
        await pause(pollMs, signal);
        continue;
      }
      if (task.reclaimed) {
        options.metrics?.reclaimedTasks.inc();
        log.warn(
          { updateId: task.updateId, taskId: task.taskId, attempt: task.attempt },
          'task re-claimed after its lease expired with no outcome; overlapping updates wait for the settle window',
        );
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
        await pause(pollMs, signal);
      }
    }
  }

  /** SPEC §7 counters for an outcome that was stored (stale results are not counted). */
  async function recordOutcome(
    task: ClaimedTask,
    action: AttemptAction,
    failedCount: number,
  ): Promise<void> {
    const metrics = options.metrics!;
    if (action.type === 'reschedule') metrics.recordRetry(action.outcome);
    else if (action.type === 'fail') metrics.tasksFinished.inc({ result: 'failed' }, failedCount);
    else {
      metrics.tasksFinished.inc({ result: 'done' });
      // Only the update's last chunk completes it: FIFO means its chunks never complete together.
      // The task is already done: a failing lookup must not turn into a slot error (which would
      // log a false "will be retried" and drop the attempt's own log line).
      try {
        const lagMs = await syncedUpdateLagMs(pool, task.updateId);
        if (lagMs !== null) metrics.updateLag.observe(lagMs / 1000);
      } catch (error) {
        log.warn({ err: error, updateId: task.updateId }, 'could not compute the update lag');
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
      options.metrics?.sendsDeferred.inc();
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
    options.metrics?.recordPortalCall(action.outcome, (endedAt - startedAt) / 1000);
    if (action.type === 'reschedule' && action.pauseForMs !== undefined) {
      limiter.pauseFor(action.pauseForMs); // every slot waits, not just this task (SPEC D4)
    }

    let applied: boolean;
    let storeFailed = false;
    let failedCount = 0;
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
            : (failedCount = await failTask(pool, task, {
                error: action.error,
                httpStatus: action.httpStatus,
              })) > 0;
    } catch (error) {
      // The lease expires and the task is retried; re-sending is safe (idempotent PUT).
      storeFailed = true;
      log.error(
        { err: error, taskId: task.taskId },
        'could not store the attempt outcome; the lease will expire',
      );
      applied = false;
    }

    if (applied && options.metrics) await recordOutcome(task, action, failedCount);
    // Not applied and not a store error: the fencing token was stale (another claim owns it).
    if (!applied && !storeFailed) options.metrics?.staleResults.inc();

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

  /** Session advisory lock: one active worker per database (SPEC D5). Disjoint key space. */
  const LEADER_LOCK = 'SELECT pg_try_advisory_lock(2, 1) AS ok';
  const leaderRetryMs = options.leaderRetryMs ?? 5_000;
  let leadership: Promise<void> | undefined;
  let active = false;

  /** Seeds the limiter with the attempts of the last minute, possibly by another process. */
  async function seedLimiter(): Promise<number> {
    const { rows } = await pool.query<{ age_ms: number }>(
      `SELECT (extract(epoch FROM now() - last_attempt_at) * 1000)::float8 AS age_ms
         FROM sync_tasks
        WHERE last_attempt_at > now() - interval '60 seconds'`,
    );
    limiter.seedRecent(rows.map((row) => row.age_ms));
    return rows.length;
  }

  async function lead(): Promise<void> {
    let announcedStandby = false;
    while (!stopping.signal.aborted) {
      let client: pg.PoolClient;
      try {
        client = await pool.connect();
      } catch (error) {
        log.warn({ err: error }, 'worker could not reach the database; retrying');
        await pause(leaderRetryMs);
        continue;
      }
      const lost = new AbortController();
      // A checked-out client that errors (connection killed) must not crash the process; losing
      // the lock's session means losing the lock, so the slots stop and we compete again.
      client.on('error', (error) => {
        log.error({ err: error }, 'worker lost its database session; stopping sends');
        lost.abort();
      });
      let leader = false;
      try {
        leader = (await client.query<{ ok: boolean }>(LEADER_LOCK)).rows[0]?.ok === true;
        if (!leader) {
          if (!announcedStandby) {
            log.info({}, 'another worker is active on this database; standing by (API only)');
            announcedStandby = true;
          }
        } else {
          const seeded = await seedLimiter();
          log.info(
            { concurrency, seededStarts: seeded },
            'worker active (holds the single-worker lock)',
          );
          announcedStandby = false;
          const run = AbortSignal.any([stopping.signal, lost.signal]);
          active = true;
          slots = Array.from({ length: concurrency }, (_, slot) => runSlot(slot, run));
          try {
            await Promise.all(slots);
          } finally {
            active = false;
          }
        }
      } catch (error) {
        log.error({ err: error }, 'worker leadership error; retrying');
      } finally {
        if (leader && !lost.signal.aborted) {
          await client.query('SELECT pg_advisory_unlock(2, 1)').catch(() => {});
        }
        client.release(lost.signal.aborted);
      }
      if (!stopping.signal.aborted) await pause(leaderRetryMs);
    }
  }

  return {
    start() {
      leadership ??= lead();
    },
    async stop() {
      stopping.abort();
      await leadership;
    },
    status: () => (active ? 'active' : 'standby'),
  };
}
