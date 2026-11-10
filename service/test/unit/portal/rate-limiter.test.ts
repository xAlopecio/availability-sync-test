import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlidingWindowRateLimiter } from '#src/portal/rate-limiter.ts';

const WINDOW = 60_000;
const limiter = (limit: number, windowMs = WINDOW) =>
  new SlidingWindowRateLimiter({ limit, windowMs });

/** Small seeded PRNG (mulberry32) so the simulation is reproducible. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('SlidingWindowRateLimiter.tryAcquire', () => {
  it('R1 / AC11: allows `limit` starts, then says how long until the oldest leaves the window', () => {
    const rl = limiter(3);
    expect(rl.tryAcquire(0)).toMatchObject({ ok: true });
    expect(rl.tryAcquire(10)).toMatchObject({ ok: true });
    expect(rl.tryAcquire(20)).toMatchObject({ ok: true });
    expect(rl.tryAcquire(30)).toEqual({ ok: false, waitMs: WINDOW - 30 });
  });

  it('R2 / AC11: a start at t occupies (t − window, t]; at t + window there is room again', () => {
    const rl = limiter(1);
    expect(rl.tryAcquire(0).ok).toBe(true);
    expect(rl.tryAcquire(WINDOW - 1)).toEqual({ ok: false, waitMs: 1 });
    expect(rl.tryAcquire(WINDOW)).toMatchObject({ ok: true });
  });

  it('R3 / AC11: in 10 simulated minutes no 60 s window ever holds more than `limit` starts', () => {
    for (const seed of [1, 2, 3, 42]) {
      const random = seeded(seed);
      const limit = 25;
      const rl = limiter(limit);
      const granted: number[] = [];
      let now = 0;
      while (now < 10 * WINDOW) {
        const result = rl.tryAcquire(now);
        if (result.ok) granted.push(now);
        else expect(result.waitMs).toBeGreaterThan(0);
        if (random() < 0.02) rl.pauseUntil(now + Math.floor(random() * 20_000));
        now += Math.floor(random() * 3_000);
      }
      expect(granted.length).toBeGreaterThan(limit * 5); // the simulation really saturated it
      for (const t of granted) {
        const inWindow = granted.filter((g) => g > t - WINDOW && g <= t).length;
        expect(inWindow).toBeLessThanOrEqual(limit);
      }
    }
  });

  it('R4: denied attempts do not consume permits', () => {
    const rl = limiter(2);
    rl.tryAcquire(0);
    rl.tryAcquire(1);
    for (let t = 100; t < WINDOW; t += 100) expect(rl.tryAcquire(t).ok).toBe(false);
    expect(rl.tryAcquire(WINDOW).ok).toBe(true); // the start at 0 left the window
    expect(rl.tryAcquire(WINDOW)).toEqual({ ok: false, waitMs: 1 }); // the start at 1 has not
    expect(rl.tryAcquire(WINDOW + 1).ok).toBe(true);
  });

  it('R5: pauseUntil denies everything until then, even with free permits', () => {
    const rl = limiter(10);
    rl.pauseUntil(5_000);
    expect(rl.tryAcquire(1_000)).toEqual({ ok: false, waitMs: 4_000 });
    expect(rl.tryAcquire(5_000)).toMatchObject({ ok: true });
  });

  it('R5: when paused and full, waits for whichever ends later', () => {
    const rl = limiter(1);
    rl.tryAcquire(0);
    rl.pauseUntil(10_000);
    expect(rl.tryAcquire(1_000)).toEqual({ ok: false, waitMs: WINDOW - 1_000 });
    rl.pauseUntil(WINDOW + 5_000);
    expect(rl.tryAcquire(1_000)).toEqual({ ok: false, waitMs: WINDOW + 4_000 });
  });

  it('R6: a shorter pause does not shorten a longer one', () => {
    const rl = limiter(10);
    rl.pauseUntil(10_000);
    rl.pauseUntil(3_000);
    expect(rl.tryAcquire(5_000)).toEqual({ ok: false, waitMs: 5_000 });
  });

  it('R7: works with limit 1', () => {
    const rl = limiter(1, 1_000);
    expect(rl.tryAcquire(0).ok).toBe(true);
    expect(rl.tryAcquire(500).ok).toBe(false);
    expect(rl.tryAcquire(1_000).ok).toBe(true);
  });

  it.each([
    [0, WINDOW],
    [-1, WINDOW],
    [2.5, WINDOW],
    [Number.NaN, WINDOW],
    [25, 0],
    [25, -1],
  ])('R9: rejects an invalid configuration (limit %s, window %s)', (limit, windowMs) => {
    expect(() => new SlidingWindowRateLimiter({ limit, windowMs })).toThrow(RangeError);
  });
});

describe('SlidingWindowRateLimiter.acquire', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('R8 / AC11: concurrent callers never exceed the limit; the extra one waits for the window', async () => {
    vi.useFakeTimers({ now: 0 });
    const rl = limiter(2, 1_000);
    const done = [false, false, false];
    const calls = done.map((_, i) =>
      rl.acquire().then(() => {
        done[i] = true;
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(done.filter(Boolean)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(done.filter(Boolean)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(done.filter(Boolean)).toHaveLength(3);
    await Promise.all(calls);
  });

  it('R8: acquire honours a pause', async () => {
    vi.useFakeTimers({ now: 0 });
    const rl = limiter(5, 1_000);
    rl.pauseUntil(3_000);
    let resolved = false;
    const call = rl.acquire().then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
    await call;
  });

  it('R10: a long pause is waited in sleeps of at most 60 s (no setTimeout overflow)', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const rl = new SlidingWindowRateLimiter({
      limit: 5,
      windowMs: 1_000,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    rl.pauseUntil(2 * 3600 * 1000);
    await rl.acquire();
    expect(clock).toBe(2 * 3600 * 1000);
    expect(sleeps.length).toBeGreaterThan(1);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(60_000);
  });
});

describe('SlidingWindowRateLimiter.pauseFor', () => {
  it("R11: pauses relative to the limiter's own clock", () => {
    const clock = 1_000;
    const rl = new SlidingWindowRateLimiter({ limit: 5, windowMs: 1_000, now: () => clock });
    rl.pauseFor(5_000);
    expect(rl.tryAcquire(5_999)).toEqual({ ok: false, waitMs: 1 });
    expect(rl.tryAcquire(6_000)).toMatchObject({ ok: true });
  });
});

describe('SlidingWindowRateLimiter.release', () => {
  it('R12: gives back the most recent permit', () => {
    const rl = limiter(1);
    const permit = rl.tryAcquire(0);
    if (!permit.ok) throw new Error('permit expected');
    expect(rl.tryAcquire(10).ok).toBe(false);
    rl.release(permit.token);
    expect(rl.tryAcquire(20)).toMatchObject({ ok: true });
  });

  it('R12: releasing with nothing taken is a no-op', () => {
    const rl = limiter(1);
    rl.release(12345); // not a permit this limiter issued
    expect(rl.tryAcquire(0).ok).toBe(true);
    expect(rl.tryAcquire(1).ok).toBe(false);
  });

  it('R12: an idle loop of acquire + release never fills the window', () => {
    const rl = limiter(2);
    for (let t = 0; t < 10_000; t += 100) {
      const permit = rl.tryAcquire(t);
      if (!permit.ok) throw new Error('permit expected');
      rl.release(permit.token);
    }
    expect(rl.tryAcquire(10_000).ok).toBe(true);
    expect(rl.tryAcquire(10_001).ok).toBe(true);
  });
});

describe('SlidingWindowRateLimiter.acquire with a signal', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('R13: aborting while waiting rejects promptly with an AbortError and takes no permit', async () => {
    vi.useFakeTimers({ now: 0 });
    const rl = limiter(1, 60_000);
    rl.tryAcquire(0); // the window is full until t = 60 000
    const controller = new AbortController();
    const waiting = rl.acquire({ signal: controller.signal });
    const outcome = waiting.then(
      () => 'resolved',
      (error: Error) => error.name,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toBe('AbortError');
    // Only the original start occupies the window: one permit is free again at t = 60 000.
    expect(rl.tryAcquire(60_000)).toMatchObject({ ok: true });
  });

  it('R13: an already-aborted signal rejects without waiting', async () => {
    const rl = limiter(1);
    await expect(rl.acquire({ signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(rl.tryAcquire(0).ok).toBe(true); // no permit was taken
  });
});

describe('SlidingWindowRateLimiter tokens and seeding', () => {
  it("R14: release(token) frees that permit, not another slot's", () => {
    const rl = limiter(2);
    const a = rl.tryAcquire(0); // slot A: its claim will come back empty
    const b = rl.tryAcquire(10); // slot B: really sends
    if (!a.ok || !b.ok) throw new Error('both permits should be granted');
    rl.release(a.token);
    expect(rl.tryAcquire(20).ok).toBe(true);
    // B's start (t = 10) still occupies the window; popping the newest would have left A's (t = 0).
    expect(rl.tryAcquire(30)).toEqual({ ok: false, waitMs: 10 + WINDOW - 30 });
  });

  it('R15: seedRecent() records starts of an earlier process, which occupy the window until they age out', () => {
    const rl = new SlidingWindowRateLimiter({ limit: 2, windowMs: WINDOW, now: () => 100_000 });
    rl.seedRecent([55_000, 10_000]); // started at 45 000 and 90 000 on this clock
    expect(rl.tryAcquire(100_000)).toEqual({ ok: false, waitMs: 45_000 + WINDOW - 100_000 });
    expect(rl.tryAcquire(105_000).ok).toBe(true); // the 55 s-old start left the window
    expect(rl.tryAcquire(105_001).ok).toBe(false); // the other one has not
  });

  it('pausedRemaining() reports what is left of the global pause', () => {
    let clock = 0;
    const rl = new SlidingWindowRateLimiter({ limit: 5, windowMs: WINDOW, now: () => clock });
    expect(rl.pausedRemaining()).toBe(0);
    rl.pauseFor(5_000);
    clock = 1_000;
    expect(rl.pausedRemaining()).toBe(4_000);
    clock = 6_000;
    expect(rl.pausedRemaining()).toBe(0);
  });
});
