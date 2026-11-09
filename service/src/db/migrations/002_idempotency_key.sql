-- Optional client-supplied key for POST /updates (SPEC §6, v5): a retry after an ambiguous
-- outcome is recognised instead of stored again. NULLs are allowed and never conflict.
ALTER TABLE updates ADD COLUMN idempotency_key text;
ALTER TABLE updates ADD CONSTRAINT updates_idempotency_key_unique UNIQUE (idempotency_key);
