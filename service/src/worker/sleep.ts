import { setTimeout as delay } from 'node:timers/promises';

/**
 * Sleeps `ms`, ending early (resolving, not rejecting) when `signal` aborts. Used by the worker
 * between polls: the loop checks `signal.aborted` itself. `timers/promises` removes its abort
 * listener when the timer fires, so thousands of idle polls leave nothing behind (the first
 * version leaked one listener per poll).
 */
export async function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if ((error as Error).name !== 'AbortError') throw error;
  }
}
