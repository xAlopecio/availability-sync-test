import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { registerErrorHandling } from './errors.ts';
import { registerSyncStatusRoutes } from './routes/sync-status.ts';
import { registerUpdateRoutes } from './routes/updates.ts';

export type AppDependencies = {
  readonly pool: pg.Pool;
  readonly maxUpdateRangeDays: number;
  /** Fastify logger options; `false` silences it (tests). */
  readonly logger?: boolean | { level: string };
};

/** Builds the HTTP app without listening, so tests can drive it with `inject()`. */
export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? true,
    bodyLimit: 1_048_576,
    // A request that is still running after 15 s is answered by Node with 408 (SPEC §8).
    requestTimeout: 15_000,
  });
  // Only JSON is accepted: without this, Fastify would parse text/plain bodies too (SPEC §6, 415).
  app.removeContentTypeParser('text/plain');
  registerErrorHandling(app);
  registerUpdateRoutes(app, deps);
  registerSyncStatusRoutes(app, deps);
  return app;
}
