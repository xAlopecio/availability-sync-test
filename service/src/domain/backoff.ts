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
  _attempt: number,
  _policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): number {
  throw new Error('not implemented');
}

/** When to try again after a transient failure. `random()` must return a value in [0, 1). */
export function nextAttemptAt(_args: {
  attempt: number;
  outcome: TransientOutcome;
  now: number;
  random: () => number;
  policy?: RetryPolicy;
}): number {
  throw new Error('not implemented');
}
