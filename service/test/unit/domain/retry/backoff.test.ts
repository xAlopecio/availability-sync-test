import { describe, expect, it } from 'vitest';
import {
  backoffCeilingMs,
  DEFAULT_RETRY_POLICY,
  nextAttemptAt,
} from '#src/domain/retry/backoff.ts';

const NOW = 1_000_000;
const unavailable = { class: 'transient', label: 'unavailable' } as const;
const delayFor = (attempt: number, random: number) =>
  nextAttemptAt({ attempt, outcome: unavailable, now: NOW, random: () => random }) - NOW;
const JUST_BELOW_ONE = 1 - Number.EPSILON;

describe('backoffCeilingMs', () => {
  it.each([
    [1, 1_000],
    [2, 2_000],
    [3, 4_000],
    [4, 8_000],
    [9, 256_000],
  ])('B1 / AC10: attempt %i → ceiling %i ms', (attempt, ceiling) => {
    expect(backoffCeilingMs(attempt)).toBe(ceiling);
  });

  it.each([10, 11, 50])('B3 / AC10: attempt %i is capped at maxMs (300 s)', (attempt) => {
    expect(backoffCeilingMs(attempt)).toBe(DEFAULT_RETRY_POLICY.maxMs);
  });

  it.each([1000, 1e6])('B4: a huge attempt number (%i) stays finite and capped', (attempt) => {
    const ceiling = backoffCeilingMs(attempt);
    expect(Number.isFinite(ceiling)).toBe(true);
    expect(ceiling).toBe(DEFAULT_RETRY_POLICY.maxMs);
  });
});

describe('nextAttemptAt', () => {
  it('B2 / AC10: full jitter — random 0 retries immediately', () => {
    expect(delayFor(3, 0)).toBe(0);
  });

  it('B2 / AC10: full jitter — random just below 1 stays below the ceiling', () => {
    const delay = delayFor(3, JUST_BELOW_ONE);
    expect(delay).toBeLessThan(4_000);
    expect(delay).toBeGreaterThan(3_990);
  });

  it('B3 / B4: never more than maxMs after now, never NaN', () => {
    for (const attempt of [10, 100, 1000, 1e6]) {
      const delay = delayFor(attempt, JUST_BELOW_ONE);
      expect(Number.isNaN(delay)).toBe(false);
      expect(delay).toBeLessThanOrEqual(DEFAULT_RETRY_POLICY.maxMs);
    }
  });

  it('B5 / AC10: rate_limited waits Retry-After plus the margin, without jitter', () => {
    const outcome = { class: 'transient', label: 'rate_limited', retryAfterMs: 17_000 } as const;
    for (const random of [0, 0.5, JUST_BELOW_ONE]) {
      expect(nextAttemptAt({ attempt: 1, outcome, now: NOW, random: () => random })).toBe(
        NOW + 17_000 + 500,
      );
    }
  });

  it('B5 / AC10: rate_limited is never earlier than Retry-After, even with a high attempt count', () => {
    const outcome = { class: 'transient', label: 'rate_limited', retryAfterMs: 45_000 } as const;
    const at = nextAttemptAt({ attempt: 1, outcome, now: NOW, random: () => 0 });
    expect(at).toBeGreaterThanOrEqual(NOW + 45_000);
    const later = nextAttemptAt({ attempt: 30, outcome, now: NOW, random: () => 0 });
    expect(later).toBeGreaterThanOrEqual(NOW + 45_000);
  });

  it('B6: the same inputs give the same result', () => {
    expect(delayFor(5, 0.37)).toBe(delayFor(5, 0.37));
  });

  it('uses the policy it is given', () => {
    const policy = { baseMs: 100, maxMs: 1_000, rateLimitMarginMs: 0 };
    expect(backoffCeilingMs(1, policy)).toBe(100);
    expect(backoffCeilingMs(5, policy)).toBe(1_000);
  });
});
