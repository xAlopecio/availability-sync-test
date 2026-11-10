import type { ObservedCall } from '../domain/retry/outcome.ts';

export type AvailabilityPut = {
  readonly from: string;
  readonly to: string;
  readonly available: boolean;
  readonly pricePerNight: number;
};

/** Talks to Portal Sol. Never throws for HTTP or transport outcomes: it reports them. */
export type PortalClient = {
  putAvailability(accommodationId: string, body: AvailabilityPut): Promise<ObservedCall>;
};

export function createPortalClient(options: {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}): PortalClient {
  const { baseUrl, apiKey, timeoutMs } = options;
  return {
    async putAvailability(accommodationId, body) {
      // The id already matches ^[A-Za-z0-9_-]{1,64}$ (validation); encoding is belt and braces.
      const url = `${baseUrl}/api/v1/accommodations/${encodeURIComponent(accommodationId)}/availability`;
      try {
        // The timeout covers the whole exchange, body included: a portal that sends headers and
        // then stalls is still a timeout. A timed-out PUT may have been applied (API.md).
        const response = await fetch(url, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
          body: JSON.stringify({
            from: body.from,
            to: body.to,
            available: body.available,
            pricePerNight: body.pricePerNight,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await response.text();
        if (response.ok) return { kind: 'response', status: response.status };
        const retryAfter = response.headers.get('retry-after');
        return {
          kind: 'response',
          status: response.status,
          ...(retryAfter === null ? {} : { retryAfter }),
          portalError: parsePortalError(text),
        };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'TimeoutError')
          return { kind: 'timeout' };
        const code = networkErrorCode(error);
        return code === undefined ? { kind: 'network_error' } : { kind: 'network_error', code };
      }
    },
  };
}

/** Portal errors look like `{ "error": { "code", "message" } }` (API.md); anything else → nulls. */
function parsePortalError(text: string): { code: string | null; message: string | null } {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    const code = parsed.error?.code;
    const message = parsed.error?.message;
    return {
      code: typeof code === 'string' ? code : null,
      message: typeof message === 'string' ? message : null,
    };
  } catch {
    return { code: null, message: null };
  }
}

/** undici wraps socket errors: `TypeError('fetch failed', { cause: { code } })`. */
function networkErrorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown; errors?: { code?: unknown }[] } }).cause;
  const code = cause?.code ?? cause?.errors?.[0]?.code;
  return typeof code === 'string' ? code : undefined;
}
