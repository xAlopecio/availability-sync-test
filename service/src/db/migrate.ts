import type pg from 'pg';

/** Directory of the numbered `.sql` migrations shipped with the service. */
export const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);

/**
 * Applies pending migrations in numeric order, each in its own transaction, recorded in
 * `schema_migrations`. Safe to run concurrently from several instances (advisory lock).
 * Returns the names of the files applied by this call.
 */
export async function migrate(
  _pool: pg.Pool,
  _options: { dir?: URL | string } = {},
): Promise<string[]> {
  throw new Error('not implemented');
}
