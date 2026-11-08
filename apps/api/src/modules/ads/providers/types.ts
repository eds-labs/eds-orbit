import type { ConnectorError } from "../../../../../../packages/connectors/src/index.ts";

export type AdsProviderId = "meta" | "openai" | "google";
export type FailureKind = "rate_limited" | "auth" | "permission" | "validation" | "transient" | "unknown";
export type FailureOutcome = "not_sent" | "rejected" | "unknown";

/** Provider-neutral failure. Never carries tokens, secrets or raw provider bodies. */
export type ProviderFailure = {
  kind: FailureKind;
  code: string;
  outcome: FailureOutcome;
  retryable: boolean;
  retryAfterMs?: number;
  httpStatus?: number;
  providerCode?: number;
  providerSubcode?: number;
  traceId?: string;
  fieldPaths: string[];
  userTitle?: string;
  userMessage?: string;
};

export type FailureInput = { write: boolean; httpStatus?: number; body?: unknown; headers?: Headers; transport?: ConnectorError };
export type ThrottleHint = { buckets: { bucket: string; usagePct: number; regainMs?: number }[]; accessTier?: "limited" | "full" };
export type ProviderManifest = { apiVersion: string; currencyUnit: "minor" | "micros"; validateOnly: boolean };

// connect (A3), read (A4) and write (A7) join this interface in their steps.
export interface AdsProvider {
  id: AdsProviderId;
  manifest: ProviderManifest;
  errors: { classify(input: FailureInput): ProviderFailure };
  usage: { parse(headers: Headers): ThrottleHint };
}

/** The message is the failure code only: never provider text, never tokens. */
export class AdsProviderError extends Error {
  constructor(readonly failure: ProviderFailure) {
    super(failure.code);
    this.name = "AdsProviderError";
  }
}
