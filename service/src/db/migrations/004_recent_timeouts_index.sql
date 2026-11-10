-- D9 hold lookups (claim and metrics): only tasks that ever timed out matter, a small fraction.
-- Without this the check scanned the accommodation's whole history for every pending task
-- (measured: 1.3 s per metrics scrape at 50k pending / 400k done tasks).
CREATE INDEX sync_tasks_recent_timeouts ON sync_tasks (accommodation_id, last_timeout_at)
  WHERE last_timeout_at IS NOT NULL;
