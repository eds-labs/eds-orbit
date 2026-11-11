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

export type ProviderApp = { clientId: string; clientSecret: string; configId?: string };
export type ProviderGrant = {
  accessToken: string;
  tokenType: "user" | "system_user";
  expiresAt: Date | null;
  userId: string;
  userName: string | null;
  grantedScopes: string[];
};
export type ProviderAccount = {
  externalId: string;
  name: string;
  currency: string;
  timezone: string;
  providerStatus: string;
  status: "active" | "disabled";
  businessId: string | null;
  businessName: string | null;
  spendCapMicros: bigint | null;
  amountSpentMicros: bigint | null;
  canWrite: boolean;
  currencySupported: boolean;
};

export interface AdsConnect {
  authorizeUrl(input: { app: ProviderApp; redirectUri: string; state: string }): string;
  finish(input: { app: ProviderApp; redirectUri: string; code: string }): Promise<ProviderGrant>;
  scopes(input: { app: ProviderApp; accessToken: string }): Promise<string[]>;
  listAccounts(input: { app: ProviderApp; accessToken: string; grantedScopes: string[] }): Promise<{ accounts: ProviderAccount[]; truncated: boolean }>;
  readAccount(input: { app: ProviderApp; accessToken: string; grantedScopes: string[]; externalId: string }): Promise<ProviderAccount>;
}

// read (A4) and write (A7) join this interface in their steps.
export interface AdsProvider {
  id: AdsProviderId;
  manifest: ProviderManifest;
  errors: { classify(input: FailureInput): ProviderFailure };
  usage: { parse(headers: Headers): ThrottleHint };
  connect?: AdsConnect;
}

/** The message is the failure code only: never provider text, never tokens. */
export class AdsProviderError extends Error {
  constructor(readonly failure: ProviderFailure) {
    super(failure.code);
    this.name = "AdsProviderError";
  }
}
