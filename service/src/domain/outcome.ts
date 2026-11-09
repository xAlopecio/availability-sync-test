/** What happened to one call to the portal, as observed by the HTTP client. */
export type PortalCallResult =
  | { readonly kind: 'response'; readonly status: number; readonly retryAfter?: string | null }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'network_error'; readonly code?: string };

/** Values of the `outcome` label of `portal_requests_total` (SPEC §7). */
export type TransientReason =
  'rate_limited' | 'unavailable' | 'timeout' | 'network_error' | 'server_error' | 'unauthorized';

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

export function classifyOutcome(result: PortalCallResult, now: number): Outcome {
  if (result.kind === 'timeout') return { class: 'transient', label: 'timeout' };
  if (result.kind === 'network_error') return { class: 'transient', label: 'network_error' };

  const { status } = result;
  if (status >= 200 && status < 300) return { class: 'success', label: 'success' };
  if (status === 429) {
    return {
      class: 'transient',
      label: 'rate_limited',
      retryAfterMs: parseRetryAfter(result.retryAfter, now) ?? RATE_LIMIT_FALLBACK_MS,
    };
  }
  if (status === 401) return { class: 'transient', label: 'unauthorized' };
  if (status >= 400 && status < 500) return { class: 'permanent', label: 'client_error', status };
  if (status === 503) return { class: 'transient', label: 'unavailable' };
  // Other 5xx, and anything we do not understand (1xx, 3xx): retry rather than drop the update.
  return { class: 'transient', label: 'server_error' };
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
