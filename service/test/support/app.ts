import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach } from 'vitest';
import { buildApp } from '#src/http/app.ts';
import type { useMigratedDatabase } from './migrated-db.ts';

/** A fresh app per test on the migrated test database, driven with `inject()`. */
export function useApp(db: ReturnType<typeof useMigratedDatabase>): () => FastifyInstance {
  let app: FastifyInstance | undefined;
  beforeEach(async () => {
    app = buildApp({ pool: db.pool(), maxUpdateRangeDays: 366, logger: false });
    await app.ready();
  });
  afterEach(async () => {
    await app?.close();
  });
  return () => {
    if (!app) throw new Error('app used outside a test');
    return app;
  };
}

/** Asserts the single error shape of SPEC §6 and returns the code. */
export function errorCodeOf(body: unknown): string {
  const record = body as { error?: { code?: unknown; message?: unknown } };
  if (
    typeof record !== 'object' ||
    Object.keys(record).join() !== 'error' ||
    Object.keys(record.error ?? {})
      .sort()
      .join() !== 'code,message' ||
    typeof record.error?.code !== 'string' ||
    typeof record.error?.message !== 'string'
  ) {
    throw new Error(`not the { error: { code, message } } shape: ${JSON.stringify(body)}`);
  }
  return record.error.code;
}
