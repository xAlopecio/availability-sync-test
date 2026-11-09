import type { FastifyInstance } from 'fastify';

/** Keys that enable prototype pollution if a body is ever merged into another object. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** A body problem with an accurate message, answered as 400 INVALID_BODY by the error handler. */
export class BodyError extends Error {
  readonly statusCode = 400;
  readonly code = 'INVALID_BODY';
}

/**
 * Parses `application/json` bodies. Fastify's parser reports a forbidden `__proto__` key with
 * the same "not valid JSON" message as a syntax error; this one keeps the protection but says
 * what is actually wrong.
 */
export function registerJsonBodyParser(app: FastifyInstance): void {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(new BodyError('Body must not be empty'), undefined);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return done(new BodyError('Body is not valid JSON'), undefined);
    }
    const forbidden = findForbiddenKey(parsed);
    if (forbidden !== undefined) {
      return done(
        new BodyError(`Body contains the forbidden property name "${forbidden}"`),
        undefined,
      );
    }
    return done(null, parsed);
  });
}

function findForbiddenKey(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) return key;
    const nested = findForbiddenKey(child);
    if (nested !== undefined) return nested;
  }
  return undefined;
}
