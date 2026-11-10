/**
 * SQL predicates shared by the claim (db/queue.ts) and the metrics (metrics/queue-state.ts), so
 * the two can never drift apart (metrics review). `$settle` is the settle window in ms.
 */

/**
 * D9: an overlapping task of the same accommodation timed out less than the settle window ago,
 * so its abandoned request may still be applied late. Uses sync_tasks_recent_timeouts.
 */
export const heldBySettle = (task: string, settleParam = '$2') => `EXISTS (
  SELECT 1 FROM sync_tasks d
   WHERE d.accommodation_id = ${task}.accommodation_id
     AND d.id <> ${task}.id
     AND d.last_timeout_at IS NOT NULL
     AND d.last_timeout_at > now() - make_interval(secs => ${settleParam}::double precision / 1000)
     AND daterange(d.date_from, d.date_to, '[]') && daterange(${task}.date_from, ${task}.date_to, '[]'))`;
