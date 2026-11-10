/** `token` identifies this permit, so `release(token)` gives back exactly this one. */
export type AcquireResult =
  { readonly ok: true; readonly token: number } | { readonly ok: false; readonly waitMs: number };

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
  /** Starts still inside the window, oldest first; `token` lets release() find its own permit. */
  #starts: { at: number; token: number }[] = [];
  #nextToken = 1;
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
    while (this.#starts.length > 0 && this.#starts[0]!.at <= now - this.#windowMs) {
      this.#starts.shift();
    }
    const pauseWait = this.#pausedUntil - now;
    const windowWait =
      this.#starts.length >= this.#limit ? this.#starts[0]!.at + this.#windowMs - now : 0;
    const waitMs = Math.max(pauseWait, windowWait);
    if (waitMs > 0) return { ok: false, waitMs };
    const token = this.#nextToken++;
    this.#starts.push({ at: now, token });
    return { ok: true, token };
  }

  /** Denies every permit until `until`, on the limiter's clock. Never shortens an existing pause. */
  pauseUntil(until: number): void {
    this.#pausedUntil = Math.max(this.#pausedUntil, until);
  }

  /** Pauses for `ms` from now, on the limiter's own clock. */
  pauseFor(ms: number): void {
    this.pauseUntil(this.#now() + ms);
  }

  /** Request starts in the current window (for the metrics). */
  windowStarts(): number {
    const now = this.#now();
    return this.#starts.filter((start) => start.at > now - this.#windowMs).length;
  }

  /** How long the global pause still lasts, or 0. */
  pausedRemaining(): number {
    return Math.max(0, this.#pausedUntil - this.#now());
  }

  /**
   * Gives back the permit identified by `token` (a claim found nothing to send, SPEC D5). Popping
   * the newest start instead could return another slot's permit and allow N + 1 in a window.
   */
  release(token: number): void {
    const index = this.#starts.findIndex((start) => start.token === token);
    if (index >= 0) this.#starts.splice(index, 1);
  }

  /** Records starts made `agesMs` ago by an earlier process (read from the database, SPEC D5). */
  seedRecent(agesMs: readonly number[]): void {
    const now = this.#now();
    for (const age of agesMs) this.#starts.push({ at: now - age, token: this.#nextToken++ });
    this.#starts.sort((a, b) => a.at - b.at);
  }

  /**
   * Waits until a permit is free and takes it; resolves with its token. Rejects with an
   * AbortError if `signal` aborts.
   */
  async acquire(options: { signal?: AbortSignal } = {}): Promise<number> {
    const { signal } = options;
    for (;;) {
      if (signal?.aborted) throw abortError();
      const result = this.tryAcquire(this.#now());
      if (result.ok) return result.token;
      await this.#sleep(Math.min(result.waitMs, MAX_SLEEP_MS), signal);
    }
  }
}
