import { describe, expect, it } from 'vitest';
import { backoffCeilingMs } from '#src/domain/retry/backoff.ts';
import { decideAttempt, type ObservedCall } from '#src/worker/decide.ts';

const NOW = Date.parse('2026-11-10T10:00:00.000Z');
const decide = (call: ObservedCall, attempt = 1, random = 0.5) =>
  decideAttempt({ attempt, call, now: NOW, random: () => random, timeoutMs: 5000 });
const http = (status: number, extra: Partial<Extract<ObservedCall, { kind: 'response' }>> = {}) =>
  ({ kind: 'response', status, ...extra }) as ObservedCall;

describe('decideAttempt', () => {
  it('WD1: 200 → complete', () => {
    expect(decide(http(200))).toEqual({ type: 'complete', outcome: 'success', httpStatus: 200 });
  });

  it('WD2: 503 on attempt 3 → reschedule at the full-jitter backoff, error "503 UNAVAILABLE"', () => {
    const call = http(503, {
      portalError: {
        code: 'UNAVAILABLE',
        message: 'Portal Sol is temporarily unavailable, please retry later',
      },
    });
    const action = decide(call, 3, 0.5);
    expect(action).toMatchObject({
      type: 'reschedule',
      outcome: 'unavailable',
      httpStatus: 503,
      error: '503 UNAVAILABLE: Portal Sol is temporarily unavailable, please retry later',
      logLevel: 'warn',
    });
    expect(action.type === 'reschedule' && action.at).toBe(
      NOW + Math.floor(0.5 * backoffCeilingMs(3)),
    );
    expect(action).not.toHaveProperty('pauseForMs');
  });

  it('WD3: 429 + Retry-After 17 → reschedule at now + 17.5 s and pause every send for 17.5 s', () => {
    const action = decide(
      http(429, {
        retryAfter: '17',
        portalError: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' },
      }),
    );
    expect(action).toMatchObject({
      type: 'reschedule',
      outcome: 'rate_limited',
      at: NOW + 17_500,
      pauseForMs: 17_500,
      httpStatus: 429,
      error: '429 RATE_LIMITED: Rate limit exceeded',
    });
  });

  it('WD4: 404 → fail with the portal code and message', () => {
    expect(
      decide(
        http(404, {
          portalError: { code: 'NOT_FOUND', message: 'Accommodation acc-9999 not found' },
        }),
      ),
    ).toEqual({
      type: 'fail',
      outcome: 'client_error',
      httpStatus: 404,
      error: '404 NOT_FOUND: Accommodation acc-9999 not found',
    });
  });

  it('WD4: an error without a portal body still has a readable message', () => {
    expect(decide(http(400))).toMatchObject({ type: 'fail', error: '400' });
  });

  it('WD5: timeout → reschedule, error "timeout after 5000 ms"', () => {
    expect(decide({ kind: 'timeout' })).toMatchObject({
      type: 'reschedule',
      outcome: 'timeout',
      error: 'timeout after 5000 ms',
      httpStatus: null,
    });
  });

  it('WD6: network error → reschedule, error "network error ECONNREFUSED"', () => {
    expect(decide({ kind: 'network_error', code: 'ECONNREFUSED' })).toMatchObject({
      type: 'reschedule',
      outcome: 'network_error',
      error: 'network error ECONNREFUSED',
      httpStatus: null,
    });
    expect(decide({ kind: 'network_error' })).toMatchObject({ error: 'network error unknown' });
  });

  it('WD7: 401 → reschedule, logged at error level (a human must fix the key)', () => {
    expect(
      decide(
        http(401, {
          portalError: { code: 'UNAUTHORIZED', message: 'Missing or invalid X-Api-Key header' },
        }),
      ),
    ).toMatchObject({
      type: 'reschedule',
      outcome: 'unauthorized',
      logLevel: 'error',
      error: '401 UNAUTHORIZED: Missing or invalid X-Api-Key header',
    });
  });

  it('WD8: an undocumented 409 → reschedule as unexpected_status', () => {
    expect(decide(http(409))).toMatchObject({
      type: 'reschedule',
      outcome: 'unexpected_status',
      error: '409',
      httpStatus: 409,
    });
  });
});
