import type { Outcome } from './outcome.ts';

export type RetryPolicy = {
  readonly baseMs: number;
  readonly maxMs: number;
  /** Added after Retry-After, which the portal sends in whole seconds (SPEC D4). */
  readonly rateLimitMarginMs: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseMs: 1_000,
  maxMs: 300_000,
  rateLimitMarginMs: 500,
};

type TransientOutcome = Extract<Outcome, { class: 'transient' }>;

/** Upper bound of the delay before retry number `attempt + 1` (`attempt` = attempts already made, ≥ 1). */
export function backoffCeilingMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): number {
  // Clamp the exponent: 2 ** 1023 is still finite but 2 ** 1024 is Infinity.
  const exponent = Math.min(Math.max(attempt - 1, 0), 52);
  return Math.min(policy.maxMs, policy.baseMs * 2 ** exponent);
}

/** When to try again after a transient failure. `random()` must return a value in [0, 1). */
export function nextAttemptAt(args: {
  attempt: number;
  outcome: TransientOutcome;
  now: number;
  random: () => number;
  policy?: RetryPolicy;
}): number {
  const { attempt, outcome, now, random, policy = DEFAULT_RETRY_POLICY } = args;
  if (outcome.label === 'rate_limited' && outcome.retryAfterMs !== undefined) {
    // The portal told us when; jitter could only make us early. The global pause in the rate
    // limiter keeps other tasks from piling in at the same instant.
    return now + outcome.retryAfterMs + policy.rateLimitMarginMs;
  }
  // Full jitter (delay uniform in [0, ceiling)): spreads retries of tasks that failed together.
  return now + Math.floor(random() * backoffCeilingMs(attempt, policy));
}
