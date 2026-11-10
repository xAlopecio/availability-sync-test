import type pg from 'pg';
import { heldBySettle } from './queue-sql.ts';

/** A task claimed by a worker slot, with everything needed to send it. */
export type ClaimedTask = {
  readonly taskId: number;
  readonly updateId: number;
  readonly accommodationId: string;
  readonly chunkIndex: number;
  readonly from: string;
  readonly to: string;
  readonly available: boolean;
  readonly pricePerNight: number;
  /** `attempts` after this claim: the fencing token for complete/reschedule/fail (SPEC D6). */
  readonly attempt: number;
};

/** Claims the oldest due head-of-queue task (SPEC D1, D6), or `null` if none is claimable. */
export async function claimTask(
  pool: pg.Pool,
  options: { leaseMs: number; settleMs?: number },
): Promise<ClaimedTask | null> {
  // Head of queue: no pending task of the same accommodation has a lower id. A leased head stays
  // `pending`, so it keeps blocking the rest of its queue while in flight (one per accommodation).
  // SKIP LOCKED lets concurrent slots pass over a head another slot is claiming right now.
  const { rows } = await pool.query(
    `WITH next AS (
       SELECT t.id
         FROM sync_tasks t
        WHERE t.status = 'pending'
          AND t.next_attempt_at <= now()
          AND (t.locked_until IS NULL OR t.locked_until < now())
          AND NOT EXISTS (
                SELECT 1 FROM sync_tasks p
                 WHERE p.accommodation_id = t.accommodation_id
                   AND p.status = 'pending'
                   AND p.id < t.id)
          -- D9: not while an overlapping task of this accommodation timed out less than the settle
          -- window ago (its abandoned request may still be applied late). Evaluated here, at claim
          -- time, so updates accepted after that task completed are held too.
          AND NOT ${heldBySettle('t', '$2')}
        ORDER BY t.next_attempt_at, t.id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE sync_tasks t
        SET locked_until = now() + make_interval(secs => $1::double precision / 1000),
            attempts = t.attempts + 1,
            last_attempt_at = now()
       FROM next, updates u
      WHERE t.id = next.id AND u.id = t.update_id
  RETURNING t.id, t.update_id, t.accommodation_id, t.chunk_index, t.date_from, t.date_to,
            u.available, u.price_per_night, t.attempts`,
    [options.leaseMs, options.settleMs ?? 0],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    taskId: row.id,
    updateId: row.update_id,
    accommodationId: row.accommodation_id,
    chunkIndex: row.chunk_index,
    from: row.date_from,
    to: row.date_to,
    available: row.available,
    pricePerNight: row.price_per_night,
    attempt: row.attempts,
  };
}

/** Fencing: only the claim that still owns the task (same `attempts`, still pending) may close it. */
const OWNED = `id = $1 AND attempts = $2 AND status = 'pending'`;

/** The task succeeded. Returns `false` if the token is stale (another claim owns it now). */
export async function completeTask(
  pool: pg.Pool,
  task: ClaimedTask,
  result: { httpStatus: number },
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE sync_tasks
        SET status = 'done', completed_at = now(), locked_until = NULL,
            last_error = NULL, last_http_status = $3
      WHERE ${OWNED}`,
    [task.taskId, task.attempt, result.httpStatus],
  );
  return rowCount === 1;
}

/**
 * A transient failure: retry after `delayMs`, measured on the **database clock** (`now()`), like
 * every other time in the queue. Taking a delay rather than an absolute time means a skew
 * between the app's and the database's clocks can never shift a retry. Returns `false` if the
 * token is stale.
 */
export async function rescheduleTask(
  pool: pg.Pool,
  task: ClaimedTask,
  result: { delayMs: number; error: string; httpStatus: number | null; timedOut?: boolean },
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE sync_tasks
        SET next_attempt_at = now() + make_interval(secs => $3::double precision / 1000),
            locked_until = NULL,
            last_error = $4, last_http_status = $5,
            last_timeout_at = CASE WHEN $6::boolean THEN now() ELSE last_timeout_at END
      WHERE ${OWNED}`,
    [
      task.taskId,
      task.attempt,
      Math.max(0, result.delayMs),
      result.error,
      result.httpStatus,
      result.timedOut ?? false,
    ],
  );
  return rowCount === 1;
}

/**
 * A permanent failure: the task and the pending siblings of its update fail together, in one
 * transaction (SPEC D4). Returns how many tasks failed (the task + its siblings), 0 if the token
 * is stale.
 */
export async function failTask(
  pool: pg.Pool,
  task: ClaimedTask,
  result: { error: string; httpStatus: number },
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `UPDATE sync_tasks
          SET status = 'failed', completed_at = now(), locked_until = NULL,
              last_error = $3, last_http_status = $4
        WHERE ${OWNED}`,
      [task.taskId, task.attempt, result.error, result.httpStatus],
    );
    if (rowCount !== 1) {
      await client.query('ROLLBACK');
      return 0;
    }
    // Siblings would fail the same way (dates are pre-validated); failing them now unblocks the
    // accommodation's next update. They are behind this task in the queue, so none is in flight.
    const siblings = await client.query(
      `UPDATE sync_tasks
          SET status = 'failed', completed_at = now(), last_error = $2
        WHERE update_id = $1 AND status = 'pending' AND id <> $3`,
      [task.updateId, result.error, task.taskId],
    );
    await client.query('COMMIT');
    return 1 + (siblings.rowCount ?? 0);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** If every task of the update is done: milliseconds from acceptance to the last completion. */
export async function syncedUpdateLagMs(pool: pg.Pool, updateId: number): Promise<number | null> {
  const { rows } = await pool.query<{ lag_ms: number | null }>(
    `SELECT CASE WHEN bool_and(t.status = 'done')
                 THEN (extract(epoch FROM max(t.completed_at) - u.accepted_at) * 1000)::float8
            END AS lag_ms
       FROM sync_tasks t
       JOIN updates u ON u.id = t.update_id
      WHERE t.update_id = $1
      GROUP BY u.accepted_at`,
    [updateId],
  );
  return rows[0]?.lag_ms ?? null;
}
