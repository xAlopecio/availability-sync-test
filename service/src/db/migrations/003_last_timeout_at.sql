-- D9 (SPEC v6): when an attempt timed out, the portal may still apply it later. Completing such a
-- task holds the accommodation's next tasks until last_timeout_at + the settle window.
ALTER TABLE sync_tasks ADD COLUMN last_timeout_at timestamptz;
