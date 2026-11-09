-- Initial schema (SPEC §5). Order of rows = order of work: updates.id is the acceptance order,
-- sync_tasks.id the send order within an accommodation (D1, D2).

CREATE TABLE updates (
  id               bigserial PRIMARY KEY,
  accommodation_id text          NOT NULL,
  date_from        date          NOT NULL,
  date_to          date          NOT NULL,
  available        boolean       NOT NULL,
  price_per_night  numeric(12,2) NOT NULL,
  accepted_at      timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT updates_range_valid CHECK (date_to >= date_from),
  CONSTRAINT updates_price_valid CHECK (price_per_night >= 0)
);

CREATE TABLE sync_tasks (
  id               bigserial PRIMARY KEY,
  update_id        bigint      NOT NULL REFERENCES updates (id),
  accommodation_id text        NOT NULL,
  chunk_index      int         NOT NULL,
  date_from        date        NOT NULL,
  date_to          date        NOT NULL,
  status           text        NOT NULL DEFAULT 'pending',
  attempts         int         NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz,
  last_error       text,
  last_http_status int,
  last_attempt_at  timestamptz,
  completed_at     timestamptz,
  CONSTRAINT sync_tasks_status_valid CHECK (status IN ('pending', 'done', 'failed')),
  CONSTRAINT sync_tasks_range_valid CHECK (date_to >= date_from AND date_to - date_from < 31),
  CONSTRAINT sync_tasks_chunk_unique UNIQUE (update_id, chunk_index)
);

-- Head-of-queue check per accommodation (D1, D6) and sync-status reads.
CREATE INDEX sync_tasks_accommodation_queue ON sync_tasks (accommodation_id, status, id);
-- Due-work scan for the claim query.
CREATE INDEX sync_tasks_due ON sync_tasks (status, next_attempt_at);
CREATE INDEX updates_accommodation ON updates (accommodation_id, id);
