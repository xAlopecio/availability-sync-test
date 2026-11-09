export type AcquireResult = { readonly ok: true } | { readonly ok: false; readonly waitMs: number };

export type RateLimiterOptions = {
  /** Maximum request starts in any window. */
  readonly limit: number;
  readonly windowMs: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
};

/**
 * Sliding window of request starts plus a global pause (set after a 429). One instance is shared
 * by every worker slot, because the portal's limit is global (SPEC D5).
 */
export class SlidingWindowRateLimiter {
  constructor(_options: RateLimiterOptions) {
    throw new Error('not implemented');
  }

  /** Takes a permit if one is free at `now`; otherwise says how long to wait. Pure, no timers. */
  tryAcquire(_now: number): AcquireResult {
    throw new Error('not implemented');
  }

  /** Denies every permit until `until` (epoch ms). Never shortens an existing pause. */
  pauseUntil(_until: number): void {
    throw new Error('not implemented');
  }

  /** Waits until a permit is free and takes it. */
  async acquire(): Promise<void> {
    throw new Error('not implemented');
  }
}
