import type { FastifyError, FastifyInstance } from 'fastify';

/** The one error shape of the API (SPEC §6), the same as Portal Sol's. */
export const errorBody = (code: string, message: string) => ({ error: { code, message } });

/** Seconds a caller should wait before retrying when the database is down (SPEC §6). */
export const DB_UNAVAILABLE_RETRY_AFTER_S = 5;

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'EPIPE',
]);

/**
 * True when the error means "the database cannot be reached right now", as opposed to a bug:
 * network errors, SQLSTATE class 08 (connection), 53 (insufficient resources), 57P (operator
 * intervention, e.g. shutdown), and pg's pool connection timeout or terminated connection.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === 'string') {
    if (NETWORK_CODES.has(code)) return true;
    // 08 connection, 53 resources, 57P operator intervention; 55P03 lock_timeout and 57014
    // statement_timeout: the database is busy, so the caller should retry, like for an outage.
    if (/^(08|53|57P|55P03$|57014$)/.test(code)) return true;
  }
  if (
    typeof message === 'string' &&
    /timeout exceeded when trying to connect|Connection terminated/i.test(message)
  ) {
    return true;
  }
  if (error instanceof AggregateError) return error.errors.some(isDatabaseUnavailable);
  return false;
}

/** Maps every failure, including Fastify's own (parsing, limits, 404), to the error shape. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send(errorBody('NOT_FOUND', `Route ${request.method} ${request.url} not found`)),
  );

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply
        .code(415)
        .send(errorBody('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'));
    }
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send(errorBody('PAYLOAD_TOO_LARGE', 'Body is larger than 1 MB'));
    }
    if (error.statusCode === 400) {
      // Malformed or empty JSON, rejected by Fastify's parser before reaching a route.
      return reply
        .code(400)
        .send(errorBody('INVALID_BODY', `Body is not valid JSON: ${error.message}`));
    }
    if (isDatabaseUnavailable(error)) {
      request.log.warn({ err: error }, 'database unavailable');
      return reply
        .code(503)
        .header('retry-after', String(DB_UNAVAILABLE_RETRY_AFTER_S))
        .send(errorBody('UNAVAILABLE', 'The database is unavailable or busy; retry later'));
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send(errorBody('INTERNAL', 'Internal error'));
  });
}
