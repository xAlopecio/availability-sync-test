/** What happened to one call to the portal, as observed by the HTTP client. */
export type PortalCallResult =
  | { readonly kind: 'response'; readonly status: number; readonly retryAfter?: string | null }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'network_error'; readonly code?: string };

/** A call result plus the portal's error body when there is one (SPEC §5 error formats). */
export type ObservedCall = PortalCallResult & {
  readonly portalError?: { readonly code: string | null; readonly message: string | null };
};

/** Values of the `outcome` label of `portal_requests_total` (SPEC §7). */
export type TransientReason =
  | 'rate_limited'
  | 'unavailable'
  | 'timeout'
  | 'network_error'
  | 'server_error'
  | 'unauthorized'
  | 'unexpected_status';

export type Outcome =
  | { readonly class: 'success'; readonly label: 'success' }
  | {
      readonly class: 'transient';
      readonly label: TransientReason;
      /** Only for `rate_limited`: how long the portal asked us to wait. */
      readonly retryAfterMs?: number;
    }
  | { readonly class: 'permanent'; readonly label: 'client_error'; readonly status: number };

/** Used when a 429 carries no usable Retry-After: the portal's full window (SPEC D4). */
export const RATE_LIMIT_FALLBACK_MS = 60_000;

/** Upper bound for any Retry-After: one bogus header must not freeze every send (SPEC D4). */
export const RATE_LIMIT_MAX_MS = 600_000;

export function classifyOutcome(result: PortalCallResult, now: number): Outcome {
  if (result.kind === 'timeout') return { class: 'transient', label: 'timeout' };
  if (result.kind === 'network_error') return { class: 'transient', label: 'network_error' };

  const { status } = result;
  if (status >= 200 && status < 300) return { class: 'success', label: 'success' };
  if (status === 429) {
    return {
      class: 'transient',
      label: 'rate_limited',
      retryAfterMs: Math.min(
        parseRetryAfter(result.retryAfter, now) ?? RATE_LIMIT_FALLBACK_MS,
        RATE_LIMIT_MAX_MS,
      ),
    };
  }
  if (status === 401) return { class: 'transient', label: 'unauthorized' };
  // Only the data errors the portal documents are permanent (SPEC D4, v3).
  if (status === 400 || status === 404)
    return { class: 'permanent', label: 'client_error', status };
  if (status === 503) return { class: 'transient', label: 'unavailable' };
  if (status >= 500 && status < 600) return { class: 'transient', label: 'server_error' };
  // Anything undocumented (other 4xx, 1xx, 3xx): retry and alert rather than drop the update.
  return { class: 'transient', label: 'unexpected_status' };
}

/** `Retry-After` is either delay-seconds or an HTTP date (RFC 9110 §10.2.3). */
function parseRetryAfter(header: string | null | undefined, now: number): number | null {
  if (header === null || header === undefined) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  // Only treat it as a date if it looks like one: V8's Date.parse turns "-5" into a date in 2001.
  if (!/[A-Za-z]/.test(value)) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at) || at <= now) return null;
  return at - now;
}
