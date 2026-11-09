import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

export type AppDependencies = {
  readonly pool: pg.Pool;
  readonly maxUpdateRangeDays: number;
  /** Fastify logger options; `false` silences it (tests). */
  readonly logger?: boolean | { level: string };
};

/** Builds the HTTP app without listening, so tests can drive it with `inject()`. */
export function buildApp(_deps: AppDependencies): FastifyInstance {
  throw new Error('not implemented');
}
