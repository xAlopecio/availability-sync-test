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

export function classifyOutcome(_result: PortalCallResult, _now: number): Outcome {
  throw new Error('not implemented');
}
