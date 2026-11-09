import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '../domain/retry/backoff.ts';
import type { PortalCallResult, TransientReason } from '../domain/retry/outcome.ts';

/** What the portal client observed, including the portal's error body when there is one. */
export type ObservedCall = PortalCallResult & {
  readonly portalError?: { readonly code: string | null; readonly message: string | null };
};

export type AttemptAction =
  | { readonly type: 'complete'; readonly outcome: 'success'; readonly httpStatus: number }
  | {
      readonly type: 'reschedule';
      readonly outcome: TransientReason;
      readonly at: number;
      readonly error: string;
      readonly httpStatus: number | null;
      /** Pause every send for this long (after a 429, SPEC D4). */
      readonly pauseForMs?: number;
      /** `error` when a human must act (401), otherwise `warn`. */
      readonly logLevel: 'warn' | 'error';
    }
  | {
      readonly type: 'fail';
      readonly outcome: 'client_error';
      readonly error: string;
      readonly httpStatus: number;
    };

/** Turns one portal call into the single action the worker applies (SPEC D4, §5). */
export function decideAttempt(_args: {
  attempt: number;
  call: ObservedCall;
  now: number;
  random: () => number;
  timeoutMs: number;
  policy?: RetryPolicy;
}): AttemptAction {
  void DEFAULT_RETRY_POLICY;
  throw new Error('not implemented');
}
