import { ConfigError, loadConfig } from './config.ts';
import { migrate } from './db/migrate.ts';
import { createPool, waitForDatabase } from './db/pool.ts';
import { buildApp } from './http/app.ts';

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

const pool = createPool(config.databaseUrl);
const app = buildApp({
  pool,
  maxUpdateRangeDays: config.maxUpdateRangeDays,
  logger: { level: config.logLevel },
});
const log = app.log;

try {
  await waitForDatabase(pool, {
    timeoutMs: config.databaseStartupTimeoutMs,
    onRetry: (error, attempt) =>
      log.warn({ attempt, err: error }, 'database not reachable yet, retrying'),
  });
} catch (error) {
  log.fatal(
    { err: error, timeoutMs: config.databaseStartupTimeoutMs },
    'database unreachable at startup; exiting without opening the port',
  );
  await pool.end().catch(() => {});
  process.exit(1);
}

const applied = await migrate(pool);
log.info({ applied }, applied.length > 0 ? 'migrations applied' : 'schema up to date');

let shuttingDown = false;
const shutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  try {
    await app.close(); // stops accepting connections, waits for in-flight requests
    log.info('http server closed');
    await pool.end();
    log.info('database pool closed');
    process.exit(0);
  } catch (error) {
    log.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
};
process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));

await app.listen({ port: config.port, host: '0.0.0.0' });
