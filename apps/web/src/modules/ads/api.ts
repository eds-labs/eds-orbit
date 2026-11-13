import { api } from "@/lib/api";

// The ads module's client side (ADR 0025): types of the /ads API.

export type AdsSettings = {
  decider: "owner";
  autoPauseAtLimit: boolean;
  utmTemplate: string | null;
  reportDay: "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
  backfillDays: number;
  insightsRetentionMonths: number;
};

/** GET /projects/:projectId/ads/status */
export type AdsStatus = {
  module: "ads";
  version: string;
  settings: AdsSettings;
  settingsVersion: number;
};

export const adsPath = (projectId: string, rest = "") =>
  `/projects/${encodeURIComponent(projectId)}/ads${rest}`;

/** Readiness of the organization's Meta app for this project (GET /connections). */
export type AppReadiness = "ready" | "project_not_granted" | "not_granted" | "invalid";

/** One ad account of the project (GET /accounts). BigInt amounts arrive as strings. */
export type AdAccountView = {
  id: string;
  provider: string;
  externalId: string;
  name: string;
  currency: string;
  timezone: string;
  status: string;
  capability: string;
  writesEnabled: boolean;
  providerStatus: string | null;
  spendCapMicros: string | null;
  amountSpentMicros: string | null;
  businessId: string | null;
  settings: { dsaBeneficiary: string | null; dsaPayor: string | null };
  health: { lastCheckedAt: string | null; lastErrorCode: string | null; nextCheckAt: string | null };
  connection: { id: string; tokenType: string; tokenExpiresAt: string | null } | null;
  version: number;
};

export type AdConnection = {
  id: string;
  label: string;
  tokenType: string;
  tokenExpiresAt: string | null;
  grantedScopes: string[];
  accountCount: number;
  /** An administrator disabled the connection: it cannot be used or renewed. */
  disabled: boolean;
  createdAt: string;
};
/** GET /connections (owner only). */
export type AdsConnectionsView = { app: AppReadiness; connections: AdConnection[] };

/** GET /connections/:id/available-accounts (owner only). */
export type AvailableAccount = {
  externalId: string;
  name: string;
  currency: string;
  timezone: string;
  businessName: string | null;
  currencySupported: boolean;
  assigned: "here" | "elsewhere" | null;
};
export type AvailableAccounts = { accounts: AvailableAccount[]; truncated: boolean };

const json = (method: string, body: unknown = {}) => ({ method, body: JSON.stringify(body) });

/** Starts Meta's login: the server returns the address to send the browser to. */
export async function startConnect(projectId: string, assign: (url: string) => void) {
  const { authorizeUrl } = await api<{ authorizeUrl: string }>(adsPath(projectId, "/connections/meta/connect"), json("POST"));
  assign(authorizeUrl);
}
export const assignAccount = (projectId: string, connectionId: string, externalId: string) =>
  api<AdAccountView>(adsPath(projectId, "/accounts"), json("POST", { connectionId, externalId }));
export const unlinkAccount = (projectId: string, account: Pick<AdAccountView, "id" | "version">) =>
  api<{ id: string; status: string; connectionRevoked: boolean }>(
    adsPath(projectId, `/accounts/${account.id}/unlink`),
    json("POST", { version: account.version }),
  );
/** Unlinks the connection's accounts and revokes it (its token is deleted). */
export const revokeConnection = (projectId: string, connectionId: string) =>
  api<{ id: string; accountsUnlinked: number }>(adsPath(projectId, `/connections/${encodeURIComponent(connectionId)}/revoke`), json("POST"));
export const checkAccount = (projectId: string, id: string) =>
  api<{ ok: boolean; code?: string }>(adsPath(projectId, `/accounts/${id}/check`), json("POST"));
export const updateAccount = (
  projectId: string,
  account: Pick<AdAccountView, "id" | "version">,
  change: { writesEnabled?: boolean; settings?: Partial<AdAccountView["settings"]> },
) => api<AdAccountView>(adsPath(projectId, `/accounts/${account.id}`), json("PATCH", { ...change, version: account.version }));

/**
 * An amount in micros (a decimal string, never parsed as a float) in the
 * account's currency and the reader's locale. The whole and fractional parts
 * are split with BigInt and handed to Intl as an exact decimal string.
 */
export function formatMicros(micros: string | null, currency: string, locale: "en" | "de"): string {
  if (micros === null || !/^-?\d+$/.test(micros)) return "\u2014";
  const value = BigInt(micros);
  const abs = value < 0n ? -value : value;
  const cents = (abs + 5_000n) / 10_000n;
  const decimal = `${value < 0n ? "-" : ""}${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
  const format = new Intl.NumberFormat(locale === "de" ? "de-DE" : "en-US", { style: "currency", currency });
  return (format as unknown as { format(value: string): string }).format(decimal);
}
