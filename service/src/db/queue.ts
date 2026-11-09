import type pg from 'pg';

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
  options: { leaseMs: number },
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
    [options.leaseMs],
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

/** A transient failure: retry at `at` (epoch ms). Returns `false` if the token is stale. */
export async function rescheduleTask(
  pool: pg.Pool,
  task: ClaimedTask,
  result: { at: number; error: string; httpStatus: number | null },
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE sync_tasks
        SET next_attempt_at = to_timestamp($3::double precision / 1000), locked_until = NULL,
            last_error = $4, last_http_status = $5
      WHERE ${OWNED}`,
    [task.taskId, task.attempt, result.at, result.error, result.httpStatus],
  );
  return rowCount === 1;
}

/**
 * A permanent failure: the task and the pending siblings of its update fail together, in one
 * transaction (SPEC D4). Returns `false` if the token is stale.
 */
export async function failTask(
  pool: pg.Pool,
  task: ClaimedTask,
  result: { error: string; httpStatus: number },
): Promise<boolean> {
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
      return false;
    }
    // Siblings would fail the same way (dates are pre-validated); failing them now unblocks the
    // accommodation's next update. They are behind this task in the queue, so none is in flight.
    await client.query(
      `UPDATE sync_tasks
          SET status = 'failed', completed_at = now(), last_error = $2
        WHERE update_id = $1 AND status = 'pending' AND id <> $3`,
      [task.updateId, result.error, task.taskId],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
