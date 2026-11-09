import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createScratchDatabase, databaseUrl, dropDatabase } from '../support/test-db.ts';
import {
  jsonLines,
  startService,
  withTimeout,
  type RunningService,
} from '../support/service-process.ts';

let dbName: string;
let service: RunningService | undefined;

beforeEach(async () => {
  dbName = await createScratchDatabase(); // empty: main.ts must migrate it itself
});
afterEach(async () => {
  if (service && service.process.exitCode === null) {
    service.process.kill('SIGKILL');
    await service.exited;
  }
  service = undefined;
  await dropDatabase(dbName);
});

const readme = {
  accommodationId: 'acc-1003',
  from: '2026-10-01',
  to: '2026-10-07',
  available: true,
  pricePerNight: 120,
};
const postUpdate = (baseUrl: string) =>
  fetch(`${baseUrl}/updates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(readme),
  });
const adminQuery = async (sql: string, params: unknown[]) => {
  const client = new pg.Client({ connectionString: databaseUrl('postgres') });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
};
const connectionsTo = async (name: string) => {
  const client = new pg.Client({ connectionString: databaseUrl('postgres') });
  await client.connect();
  try {
    const { rows } = await client.query(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
      [name],
    );
    return rows[0].n as number;
  } finally {
    await client.end();
  }
};

describe('service process', () => {
  it('W1: migrates an empty database, then serves both endpoints over a real port', async () => {
    service = startService({ DATABASE_URL: databaseUrl(dbName) });
    const baseUrl = await withTimeout(service.listening, 15_000, 'listening');

    const accepted = await postUpdate(baseUrl);
    expect(accepted.status).toBe(202);
    const status = await fetch(`${baseUrl}/accommodations/acc-1003/sync-status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ status: 'pending', pendingUpdates: 1 });
  });

  it('W2: SIGTERM closes the server, then the pool, and exits with code 0', async () => {
    service = startService({ DATABASE_URL: databaseUrl(dbName) });
    const baseUrl = await withTimeout(service.listening, 15_000, 'listening');
    expect(await connectionsTo(dbName)).toBeGreaterThan(0);

    service.process.kill('SIGTERM');
    expect(await withTimeout(service.exited, 5_000, 'exit after SIGTERM')).toEqual({
      code: 0,
      signal: null,
    });
    await expect(postUpdate(baseUrl)).rejects.toThrow(); // nothing listening any more
    // Counting connections after exit proves nothing (the OS closes them on any exit), so check
    // that the graceful sequence actually ran, in order.
    const steps = jsonLines(service.lines)
      .map((l) => l['msg'])
      .filter((m) =>
        ['shutting down', 'http server closed', 'database pool closed'].includes(String(m)),
      );
    expect(steps).toEqual(['shutting down', 'http server closed', 'database pool closed']);
  });

  it('W3: with the database unreachable it retries, then exits non-zero without ever listening', async () => {
    const started = Date.now();
    service = startService({
      DATABASE_URL: 'postgres://sync:sync@127.0.0.1:1/nowhere',
      DATABASE_STARTUP_TIMEOUT_MS: '1500',
    });
    const { code } = await withTimeout(service.exited, 10_000, 'exit');
    expect(code).not.toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500); // it did retry for the window
    const logs = jsonLines(service.lines);
    expect(logs.some((l) => /listening/i.test(String(l['msg'])))).toBe(false);
    expect(logs.some((l) => /database unreachable/i.test(String(l['msg'])))).toBe(true);
  });

  it('W4: logs are JSON; an accepted update logs updateId, accommodationId and chunks', async () => {
    service = startService({ DATABASE_URL: databaseUrl(dbName) });
    const baseUrl = await withTimeout(service.listening, 15_000, 'listening');
    const { updateId } = (await (await postUpdate(baseUrl)).json()) as { updateId: number };
    await new Promise((resolve) => setTimeout(resolve, 200)); // let the log line flush

    const logs = jsonLines(service.lines); // throws if any line is not JSON
    expect(logs.find((l) => l['msg'] === 'update accepted')).toMatchObject({
      updateId,
      accommodationId: 'acc-1003',
      chunks: 1,
    });
    expect(logs.some((l) => l['msg'] === 'incoming request' && l['reqId'])).toBe(true);
  });

  it('W5: PostgreSQL killing the connections while running does not crash the process', async () => {
    service = startService({ DATABASE_URL: databaseUrl(dbName) });
    const baseUrl = await withTimeout(service.listening, 15_000, 'listening');
    expect((await fetch(`${baseUrl}/accommodations/acc-1003/sync-status`)).status).toBe(404);

    await adminQuery(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [dbName],
    );
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(service.process.exitCode).toBeNull(); // still alive
    expect((await postUpdate(baseUrl)).status).toBe(202); // reconnected
    const logs = jsonLines(service.lines);
    expect(logs.some((l) => /pool/i.test(String(l['msg'])) && Number(l['level']) >= 40)).toBe(true);
  });

  it('W6: a failing migration logs a structured fatal line and exits 1 without listening', async () => {
    await adminQuery('SELECT 1', []); // server reachable
    const client = new pg.Client({ connectionString: databaseUrl(dbName) });
    await client.connect();
    await client.query('CREATE TABLE updates (id int)'); // 001_init.sql will fail on it
    await client.end();

    service = startService({ DATABASE_URL: databaseUrl(dbName) });
    const { code } = await withTimeout(service.exited, 15_000, 'exit');
    expect(code).toBe(1);
    const logs = jsonLines(service.lines); // every line JSON, no raw stack trace
    expect(logs.some((l) => /listening/i.test(String(l['msg'])))).toBe(false);
    expect(logs.some((l) => Number(l['level']) === 60 && /migration/i.test(String(l['msg'])))).toBe(
      true,
    );
  });

  it('W7: SIGTERM with a request stuck past SHUTDOWN_GRACE_MS logs it and exits 1', async () => {
    service = startService({ DATABASE_URL: databaseUrl(dbName), SHUTDOWN_GRACE_MS: '500' });
    const baseUrl = await withTimeout(service.listening, 15_000, 'listening');
    const holder = new pg.Client({ connectionString: databaseUrl(dbName) });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(1, hashtext($1))', ['acc-1003']);
      const stuck = postUpdate(baseUrl).catch(() => undefined); // waits on the lock (≤ 5 s)
      await new Promise((resolve) => setTimeout(resolve, 300));

      const started = Date.now();
      service.process.kill('SIGTERM');
      const { code } = await withTimeout(service.exited, 4_000, 'forced exit');
      expect(code).toBe(1);
      expect(Date.now() - started).toBeLessThan(3_000); // well before the 5 s lock timeout
      expect(
        jsonLines(service.lines).some((l) => /shutdown timed out/i.test(String(l['msg']))),
      ).toBe(true);
      await stuck;
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      await holder.end();
    }
  });
});
