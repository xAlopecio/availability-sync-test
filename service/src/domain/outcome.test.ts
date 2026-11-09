import { describe, expect, it } from 'vitest';
import { classifyOutcome, RATE_LIMIT_FALLBACK_MS, type PortalCallResult } from './outcome.ts';

const NOW = Date.parse('2026-11-09T10:00:00.000Z');
const response = (status: number, retryAfter?: string | null): PortalCallResult =>
  retryAfter === undefined
    ? { kind: 'response', status }
    : { kind: 'response', status, retryAfter };
const classify = (result: PortalCallResult) => classifyOutcome(result, NOW);

describe('classifyOutcome', () => {
  it.each([200, 204])('O1 / AC10: %i is success', (status) => {
    expect(classify(response(status))).toEqual({ class: 'success', label: 'success' });
  });

  it('O2 / AC10: 429 with Retry-After in seconds', () => {
    expect(classify(response(429, '17'))).toEqual({
      class: 'transient',
      label: 'rate_limited',
      retryAfterMs: 17_000,
    });
  });

  it('O3 / AC10: 429 with Retry-After as an HTTP date, relative to now', () => {
    const in30s = new Date(NOW + 30_000).toUTCString();
    expect(classify(response(429, in30s))).toEqual({
      class: 'transient',
      label: 'rate_limited',
      retryAfterMs: 30_000,
    });
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['garbage', 'soon'],
    ['negative', '-5'],
    ['decimal', '17.5'],
    ['a past HTTP date', new Date(NOW - 10_000).toUTCString()],
  ])('O4 / AC10: 429 with a %s Retry-After falls back to the full window', (_, retryAfter) => {
    expect(classify(response(429, retryAfter as string | null | undefined))).toEqual({
      class: 'transient',
      label: 'rate_limited',
      retryAfterMs: RATE_LIMIT_FALLBACK_MS,
    });
  });

  it('O5: 429 with Retry-After 0 means retry now', () => {
    expect(classify(response(429, '0'))).toMatchObject({ label: 'rate_limited', retryAfterMs: 0 });
  });

  it('O6 / AC10: 503 is transient unavailable', () => {
    expect(classify(response(503))).toEqual({ class: 'transient', label: 'unavailable' });
  });

  it.each([500, 502, 504])('O7 / AC10: %i is transient server_error', (status) => {
    expect(classify(response(status))).toEqual({ class: 'transient', label: 'server_error' });
  });

  it('O8 / AC10: a client-side timeout is transient (the PUT may have been applied; it is idempotent)', () => {
    expect(classify({ kind: 'timeout' })).toEqual({ class: 'transient', label: 'timeout' });
  });

  it.each(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', undefined])(
    'O9 / AC10: a network error (%s) is transient',
    (code) => {
      const result: PortalCallResult =
        code === undefined ? { kind: 'network_error' } : { kind: 'network_error', code };
      expect(classify(result)).toEqual({ class: 'transient', label: 'network_error' });
    },
  );

  it('O10 / AC10: 401 is transient unauthorized (fixable config, the queue is kept)', () => {
    expect(classify(response(401))).toEqual({ class: 'transient', label: 'unauthorized' });
  });

  it.each([400, 404, 409, 422])('O11 / AC10: %i is permanent client_error', (status) => {
    expect(classify(response(status))).toEqual({
      class: 'permanent',
      label: 'client_error',
      status,
    });
  });

  it.each([302, 304, 100])(
    'O12: an unexpected %i is transient (never drop an update on something unknown)',
    (status) => {
      expect(classify(response(status))).toEqual({ class: 'transient', label: 'server_error' });
    },
  );
});
