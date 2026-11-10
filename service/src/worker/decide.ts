import { DEFAULT_RETRY_POLICY, nextAttemptAt, type RetryPolicy } from '../domain/retry/backoff.ts';
import {
  classifyOutcome,
  type ObservedCall,
  type TransientReason,
} from '../domain/retry/outcome.ts';

/** Re-exported for the worker's callers; the type lives in the domain (the client uses it too). */
export type { ObservedCall } from '../domain/retry/outcome.ts';

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
export function decideAttempt(args: {
  attempt: number;
  call: ObservedCall;
  now: number;
  random: () => number;
  timeoutMs: number;
  policy?: RetryPolicy;
}): AttemptAction {
  const { attempt, call, now, random, timeoutMs, policy = DEFAULT_RETRY_POLICY } = args;
  const outcome = classifyOutcome(call, now);
  const httpStatus = call.kind === 'response' ? call.status : null;

  if (outcome.class === 'success') {
    return { type: 'complete', outcome: 'success', httpStatus: httpStatus! };
  }
  const error = describeFailure(call, timeoutMs);
  if (outcome.class === 'permanent') {
    return { type: 'fail', outcome: 'client_error', error, httpStatus: outcome.status };
  }
  const at = nextAttemptAt({ attempt, outcome, now, random, policy });
  return {
    type: 'reschedule',
    outcome: outcome.label,
    at,
    error,
    httpStatus,
    ...(outcome.label === 'rate_limited' ? { pauseForMs: at - now } : {}),
    logLevel: outcome.label === 'unauthorized' ? 'error' : 'warn',
  };
}

/** SPEC §5 formats: "<status> <CODE>: <message>", "timeout after <ms> ms", "network error <code>". */
function describeFailure(call: ObservedCall, timeoutMs: number): string {
  if (call.kind === 'timeout') return `timeout after ${timeoutMs} ms`;
  if (call.kind === 'network_error') return `network error ${call.code ?? 'unknown'}`;
  const { code, message } = call.portalError ?? { code: null, message: null };
  if (code === null) return String(call.status);
  return message === null ? `${call.status} ${code}` : `${call.status} ${code}: ${message}`;
}
