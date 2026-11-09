export type AcquireResult = { readonly ok: true } | { readonly ok: false; readonly waitMs: number };

export type RateLimiterOptions = {
  /** Maximum request starts in any window. */
  readonly limit: number;
  readonly windowMs: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Sliding window of request starts plus a global pause (set after a 429). One instance is shared
 * by every worker slot, because the portal's limit is global (SPEC D5).
 */
export class SlidingWindowRateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  /** Start times still inside the window, oldest first. */
  #starts: number[] = [];
  #pausedUntil = 0;

  constructor(options: RateLimiterOptions) {
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new RangeError(`rate limiter: limit must be a positive integer, got ${options.limit}`);
    }
    if (!(options.windowMs > 0)) {
      throw new RangeError(`rate limiter: windowMs must be > 0, got ${options.windowMs}`);
    }
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? (() => Date.now());
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /** Takes a permit if one is free at `now`; otherwise says how long to wait. Pure, no timers. */
  tryAcquire(now: number): AcquireResult {
    // A start at t occupies (t − window, t], so it leaves the window exactly at t + window.
    while (this.#starts.length > 0 && this.#starts[0]! <= now - this.#windowMs)
      this.#starts.shift();
    const pauseWait = this.#pausedUntil - now;
    const windowWait =
      this.#starts.length >= this.#limit ? this.#starts[0]! + this.#windowMs - now : 0;
    const waitMs = Math.max(pauseWait, windowWait);
    if (waitMs > 0) return { ok: false, waitMs };
    this.#starts.push(now);
    return { ok: true };
  }

  /** Denies every permit until `until` (epoch ms). Never shortens an existing pause. */
  pauseUntil(until: number): void {
    this.#pausedUntil = Math.max(this.#pausedUntil, until);
  }

  /** Waits until a permit is free and takes it. */
  async acquire(): Promise<void> {
    for (;;) {
      const result = this.tryAcquire(this.#now());
      if (result.ok) return;
      await this.#sleep(result.waitMs);
    }
  }
}
