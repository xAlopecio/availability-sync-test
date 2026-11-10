import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { sleepUnlessAborted } from '#src/worker/sleep.ts';

describe('sleepUnlessAborted', () => {
  it('L14: leaves no abort listener behind after sleeps that end normally (no leak while idle)', async () => {
    const controller = new AbortController();
    for (let i = 0; i < 200; i++) await sleepUnlessAborted(0, controller.signal);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('L14: resolves promptly when the signal aborts', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const sleeping = sleepUnlessAborted(10_000, controller.signal);
    controller.abort();
    await sleeping;
    expect(Date.now() - started).toBeLessThan(500);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
