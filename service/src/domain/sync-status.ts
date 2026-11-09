export type TaskStatus = 'pending' | 'done' | 'failed';
export type UpdateStatus = 'pending' | 'synced' | 'failed';

/** An update always has at least one task (one per ≤ 31-day chunk). */
export type NonEmpty<T> = readonly [T, ...T[]];

/** SPEC §5: failed if any task failed, synced if all are done, otherwise pending. */
export function deriveUpdateStatus(tasks: NonEmpty<TaskStatus>): UpdateStatus {
  if (tasks.includes('failed')) return 'failed';
  return tasks.every((task) => task === 'done') ? 'synced' : 'pending';
}

/**
 * SPEC §6: pending if any update is pending; otherwise failed if the most recent update (highest
 * `updateId`) failed; otherwise synced. `null` when the accommodation has no updates.
 */
export function deriveAccommodationStatus(
  updates: readonly { readonly updateId: number; readonly status: UpdateStatus }[],
): UpdateStatus | null {
  if (updates.length === 0) return null;
  if (updates.some((update) => update.status === 'pending')) return 'pending';
  const latest = updates.reduce((a, b) => (b.updateId > a.updateId ? b : a));
  return latest.status;
}
