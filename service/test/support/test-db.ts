import { randomUUID } from 'node:crypto';
import pg from 'pg';

/**
 * Integration tests use their own databases on the docker-compose PostgreSQL, never the `sync`
 * dev database. Override the server with TEST_DATABASE_SERVER_URL (no database name).
 */
const SERVER = (
  process.env['TEST_DATABASE_SERVER_URL'] ?? 'postgres://sync:sync@localhost:5432'
).replace(/\/+$/, '');

export const TEST_DATABASE = 'sync_test';
export const databaseUrl = (name: string = TEST_DATABASE) => `${SERVER}/${name}`;

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl('postgres') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const quote = (name: string) => {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsafe database name: ${name}`);
  return `"${name}"`;
};

export async function recreateDatabase(name: string): Promise<void> {
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${quote(name)}`);
  });
}

export async function dropDatabase(name: string): Promise<void> {
  await withAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`));
}

/** A fresh, empty database for one test; drop it with `dropDatabase(name)`. */
export async function createScratchDatabase(): Promise<string> {
  const name = `sync_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await recreateDatabase(name);
  return name;
}
