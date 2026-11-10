/**
 * Sleeps `ms`, ending early (resolving, not rejecting) when `signal` aborts. Used by the worker
 * between polls: the loop checks `signal.aborted` itself.
 */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  // Stub: the worker's original pause, which never removes its listener (the review's R2).
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });
}
