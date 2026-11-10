import { ConfigError, loadConfig } from './config.ts';
import { migrate } from './db/migrate.ts';
import { createPool, waitForDatabase } from './db/pool.ts';
import { DEFAULT_RETRY_POLICY } from './domain/retry/backoff.ts';
import { buildApp } from './http/app.ts';
import { createPortalClient } from './portal/client.ts';
import { SlidingWindowRateLimiter } from './portal/rate-limiter.ts';
import { createWorker, type Worker } from './worker/worker.ts';

// Startup order (SPEC §8): config → database (retried) → migrations → HTTP. The port only opens
// once updates can be persisted.
let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  // No logger exists yet; the message lists every invalid variable.
  process.stderr.write(`${error instanceof ConfigError ? error.message : String(error)}\n`);
  process.exit(1);
}

// The pool reports idle-connection failures through this hook; the app's logger is attached to it
// once the app exists (the pool must exist first, because the app depends on it).
let logPoolError: (error: Error) => void = () => {};
const pool = createPool(config.databaseUrl, { onError: (error) => logPoolError(error) });
const app = buildApp({
  pool,
  maxUpdateRangeDays: config.maxUpdateRangeDays,
  logger: { level: config.logLevel },
});
const log = app.log;
logPoolError = (error) =>
  log.warn({ err: error }, 'database pool connection error; it will reconnect on the next query');

const fail = async (message: string, error: unknown) => {
  log.fatal({ err: error }, message);
  await pool.end().catch(() => {});
  process.exit(1);
};

try {
  await waitForDatabase(pool, {
    timeoutMs: config.databaseStartupTimeoutMs,
    onRetry: (error, attempt) =>
      log.warn({ attempt, err: error }, 'database not reachable yet, retrying'),
  });
} catch (error) {
  await fail('database unreachable at startup; exiting without opening the port', error);
}

try {
  const applied = await migrate(pool);
  log.info({ applied }, applied.length > 0 ? 'migrations applied' : 'schema up to date');
} catch (error) {
  await fail('migration failed at startup; exiting without opening the port', error);
}

// The worker shares the process with the API (SPEC §3) unless WORKER_ENABLED=false.
let worker: Worker | undefined;
if (config.worker.enabled) {
  worker = createWorker({
    pool,
    client: createPortalClient({
      baseUrl: config.portal.baseUrl,
      apiKey: config.portal.apiKey,
      timeoutMs: config.portal.timeoutMs,
    }),
    // One limiter for every slot: the portal's limit is global (SPEC D5).
    limiter: new SlidingWindowRateLimiter({
      limit: config.portal.maxRequestsPerMinute,
      windowMs: 60_000,
    }),
    log,
    concurrency: config.worker.concurrency,
    leaseMs: config.worker.leaseMs,
    pollMs: config.worker.pollMs,
    timeoutMs: config.portal.timeoutMs,
    timeoutSettleMs: config.portal.timeoutSettleMs,
    retry: { ...DEFAULT_RETRY_POLICY, baseMs: config.retry.baseMs, maxMs: config.retry.maxMs },
  });
}

let shuttingDown = false;
const shutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  // A request stuck on the database must not keep the process alive forever.
  const force = setTimeout(() => {
    log.error({ graceMs: config.shutdownGraceMs }, 'shutdown timed out; forcing exit');
    process.exit(1);
  }, config.shutdownGraceMs);
  try {
    if (worker) {
      await worker.stop(); // no new claims; in-flight attempts finish and store their outcome
      log.info('worker stopped');
    }
    await app.close(); // stops accepting connections, waits for in-flight requests
    log.info('http server closed');
    await pool.end();
    log.info('database pool closed');
    clearTimeout(force);
    process.exit(0);
  } catch (error) {
    log.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
};
process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));

await app.listen({ port: config.port, host: '0.0.0.0' });
if (worker) {
  worker.start();
  log.info({ concurrency: config.worker.concurrency }, 'worker started');
} else {
  log.info('worker disabled (WORKER_ENABLED=false): API only');
}
