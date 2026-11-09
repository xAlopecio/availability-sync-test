import type { ObservedCall } from '../worker/decide.ts';

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

export function createPortalClient(_options: {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}): PortalClient {
  throw new Error('not implemented');
}
