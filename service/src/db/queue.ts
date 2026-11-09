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
  _pool: pg.Pool,
  _options: { leaseMs: number },
): Promise<ClaimedTask | null> {
  throw new Error('not implemented');
}

/** The task succeeded. Returns `false` if the token is stale (another claim owns it now). */
export async function completeTask(
  _pool: pg.Pool,
  _task: ClaimedTask,
  _result: { httpStatus: number },
): Promise<boolean> {
  throw new Error('not implemented');
}

/** A transient failure: retry at `at` (epoch ms). Returns `false` if the token is stale. */
export async function rescheduleTask(
  _pool: pg.Pool,
  _task: ClaimedTask,
  _result: { at: number; error: string; httpStatus: number | null },
): Promise<boolean> {
  throw new Error('not implemented');
}

/**
 * A permanent failure: the task and the pending siblings of its update fail together, in one
 * transaction (SPEC D4). Returns `false` if the token is stale.
 */
export async function failTask(
  _pool: pg.Pool,
  _task: ClaimedTask,
  _result: { error: string; httpStatus: number },
): Promise<boolean> {
  throw new Error('not implemented');
}
