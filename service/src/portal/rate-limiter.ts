export type AcquireResult = { readonly ok: true } | { readonly ok: false; readonly waitMs: number };

export type RateLimiterOptions = {
  /** Maximum request starts in any window. */
  readonly limit: number;
  readonly windowMs: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const abortError = () =>
  new DOMException('The wait for a rate-limit permit was aborted', 'AbortError');

/** setTimeout-based sleep that ends early, rejecting, when `signal` aborts. */
const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** setTimeout overflows above 2^31 − 1 ms into a 1 ms busy loop; long waits are slept in steps. */
const MAX_SLEEP_MS = 60_000;

/**
 * Sliding window of request starts plus a global pause (set after a 429). One instance is shared
 * by every worker slot, because the portal's limit is global (SPEC D5).
 */
export class SlidingWindowRateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
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
    // Monotonic by default: a wall clock stepping back would stall every send (SPEC D5).
    this.#now = options.now ?? (() => performance.now());
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

  /** Denies every permit until `until`, on the limiter's clock. Never shortens an existing pause. */
  pauseUntil(until: number): void {
    this.#pausedUntil = Math.max(this.#pausedUntil, until);
  }

  /** Pauses for `ms` from now, on the limiter's own clock. */
  pauseFor(ms: number): void {
    this.pauseUntil(this.#now() + ms);
  }

  /** Gives back the most recent permit (a claim found nothing to send, SPEC D5). */
  release(): void {
    this.#starts.pop();
  }

  /** Waits until a permit is free and takes it; rejects with an AbortError if `signal` aborts. */
  async acquire(options: { signal?: AbortSignal } = {}): Promise<void> {
    const { signal } = options;
    for (;;) {
      if (signal?.aborted) throw abortError();
      const result = this.tryAcquire(this.#now());
      if (result.ok) return;
      await this.#sleep(Math.min(result.waitMs, MAX_SLEEP_MS), signal);
    }
  }
}
