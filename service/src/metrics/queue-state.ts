import type pg from 'pg';
import { Gauge, Registry } from 'prom-client';

export const PENDING_STATES = [
  'ready',
  'in_flight',
  'waiting_retry',
  'held_settle',
  'queued',
] as const;
export const STUCK_HEAD_ATTEMPTS = 10;

export type QueueState = {
  readonly pending: Record<(typeof PENDING_STATES)[number], number>;
  readonly oldestPendingAgeSeconds: number;
  readonly stuckHeads: number;
  readonly headAttemptsMax: number;
};

/**
 * One aggregate query per scrape. Each pending task gets exactly one state, checked in the same
 * order as the claim's conditions (D1, D6, D9): leased → in flight; not the head of its
 * accommodation → queued; not due → waiting for a retry; held by an overlapping recent timeout →
 * held_settle; otherwise it would be claimed now.
 */
export async function readQueueState(pool: pg.Pool, settleMs: number): Promise<QueueState> {
  const { rows } = await pool.query(
    `WITH p AS (
       SELECT t.attempts, t.next_attempt_at, t.locked_until, u.accepted_at,
              NOT EXISTS (SELECT 1 FROM sync_tasks e
                           WHERE e.accommodation_id = t.accommodation_id
                             AND e.status = 'pending' AND e.id < t.id) AS is_head,
              EXISTS (SELECT 1 FROM sync_tasks d
                       WHERE d.accommodation_id = t.accommodation_id AND d.id <> t.id
                         AND d.last_timeout_at > now() - make_interval(secs => $1::double precision / 1000)
                         AND daterange(d.date_from, d.date_to, '[]') && daterange(t.date_from, t.date_to, '[]')) AS held
         FROM sync_tasks t
         JOIN updates u ON u.id = t.update_id
        WHERE t.status = 'pending'
     ), s AS (
       SELECT *, CASE
                   WHEN locked_until > now() THEN 'in_flight'
                   WHEN NOT is_head THEN 'queued'
                   WHEN next_attempt_at > now() THEN 'waiting_retry'
                   WHEN held THEN 'held_settle'
                   ELSE 'ready'
                 END AS state
         FROM p
     )
     SELECT count(*) FILTER (WHERE state = 'ready') AS ready,
            count(*) FILTER (WHERE state = 'in_flight') AS in_flight,
            count(*) FILTER (WHERE state = 'waiting_retry') AS waiting_retry,
            count(*) FILTER (WHERE state = 'held_settle') AS held_settle,
            count(*) FILTER (WHERE state = 'queued') AS queued,
            coalesce(extract(epoch FROM now() - min(accepted_at)), 0)::float8 AS oldest_age,
            count(*) FILTER (WHERE is_head AND attempts >= $2) AS stuck_heads,
            coalesce(max(attempts) FILTER (WHERE is_head), 0) AS head_attempts_max
       FROM s`,
    [settleMs, STUCK_HEAD_ATTEMPTS],
  );
  const row = rows[0];
  return {
    pending: {
      ready: row.ready,
      in_flight: row.in_flight,
      waiting_retry: row.waiting_retry,
      held_settle: row.held_settle,
      queued: row.queued,
    },
    oldestPendingAgeSeconds: row.oldest_age,
    stuckHeads: row.stuck_heads,
    headAttemptsMax: row.head_attempts_max,
  };
}

/**
 * The DB-derived gauges, in a registry built for one scrape: if the database cannot be read they
 * are absent (prom-client always prints an unlabelled gauge, even after reset(), so a long-lived
 * gauge would report a false 0).
 */
export function queueStateRegistry(state: QueueState | null): Registry {
  const registry = new Registry();
  const registers = [registry];
  new Gauge({
    name: 'sync_metrics_db_up',
    help: '1 if the queue gauges could be read from the database at this scrape.',
    registers,
  }).set(state === null ? 0 : 1);
  if (state === null) return registry;

  const pending = new Gauge({
    name: 'sync_tasks_pending',
    help: 'Pending tasks by state: ready, in_flight, waiting_retry, held_settle (D9), queued (FIFO).',
    labelNames: ['state'],
    registers,
  });
  for (const name of PENDING_STATES) pending.set({ state: name }, state.pending[name]);
  new Gauge({
    name: 'sync_oldest_pending_task_age_seconds',
    help: 'Age of the oldest pending update since it was accepted (how long a manager waits).',
    registers,
  }).set(state.oldestPendingAgeSeconds);
  new Gauge({
    name: 'sync_stuck_heads',
    help: 'Accommodations whose head task has at least min_attempts attempts (head-of-line blocking).',
    labelNames: ['min_attempts'],
    registers,
  }).set({ min_attempts: String(STUCK_HEAD_ATTEMPTS) }, state.stuckHeads);
  new Gauge({
    name: 'sync_head_attempts_max',
    help: 'Highest attempt count among the heads of the accommodation queues.',
    registers,
  }).set(state.headAttemptsMax);
  return registry;
}
