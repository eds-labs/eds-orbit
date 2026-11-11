import { z } from "zod";
import { AdsProviderError, type AdsConnect, type ProviderAccount, type ProviderApp } from "../types.ts";
import { createMetaGraphClient } from "./graph.ts";
import { META_CURRENCY_OFFSETS, metaMinorToMicros } from "./money.ts";

export const AD_ACCOUNT_FIELDS = "id,account_id,name,currency,timezone_name,account_status,disable_reason,business{id,name},amount_spent,spend_cap,user_tasks";
const MAX_PAGES = 10;
const ACCOUNT_ID = /^act_\d{1,32}$/;

const STATUS_NAMES: Record<number, string> = {
  1: "ACTIVE", 2: "DISABLED", 3: "UNSETTLED", 7: "PENDING_RISK_REVIEW", 8: "PENDING_SETTLEMENT",
  9: "IN_GRACE_PERIOD", 100: "PENDING_CLOSURE", 101: "CLOSED", 201: "ANY_ACTIVE", 202: "ANY_CLOSED",
};
const DISABLED_STATUSES = new Set([2, 100, 101]);

const accountSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  currency: z.string().min(1),
  timezone_name: z.string().optional(),
  account_status: z.number().int(),
  disable_reason: z.number().int().optional(),
  business: z.object({ id: z.string(), name: z.string().optional() }).optional(),
  amount_spent: z.string().optional(),
  spend_cap: z.string().optional(),
  user_tasks: z.array(z.string()).optional(),
});
type MetaAccount = z.infer<typeof accountSchema>;

function mapAccount(raw: MetaAccount, grantedScopes: string[]): ProviderAccount {
  const statusName = STATUS_NAMES[raw.account_status] ?? `CODE_${raw.account_status}`;
  const currencySupported = Object.hasOwn(META_CURRENCY_OFFSETS, raw.currency);
  const capped = raw.spend_cap !== undefined && raw.spend_cap !== "0";
  return {
    externalId: raw.id,
    name: raw.name ?? raw.id,
    currency: raw.currency,
    timezone: raw.timezone_name ?? "UTC",
    providerStatus: raw.disable_reason !== undefined && raw.disable_reason > 0 ? `${statusName}:${raw.disable_reason}` : statusName,
    status: DISABLED_STATUSES.has(raw.account_status) ? "disabled" : "active",
    businessId: raw.business?.id ?? null,
    businessName: raw.business?.name ?? null,
    spendCapMicros: currencySupported && capped ? metaMinorToMicros(raw.spend_cap!, raw.currency) : null,
    amountSpentMicros: currencySupported && raw.amount_spent !== undefined ? metaMinorToMicros(raw.amount_spent, raw.currency) : null,
    canWrite: grantedScopes.includes("ads_management")
      && (raw.user_tasks === undefined || raw.user_tasks.includes("MANAGE") || raw.user_tasks.includes("ADVERTISE")),
    currencySupported,
  };
}

export async function listAccounts(input: { app: ProviderApp; accessToken: string; grantedScopes: string[] }) {
  const client = createMetaGraphClient({ accessToken: input.accessToken, appSecret: input.app.clientSecret });
  const accounts: ProviderAccount[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.page("/me/adaccounts", { fields: AD_ACCOUNT_FIELDS, limit: "100" }, accountSchema, after);
    for (const item of result.items) accounts.push(mapAccount(item, input.grantedScopes));
    after = result.after;
    if (after === undefined) return { accounts, truncated: false };
  }
  return { accounts, truncated: true };
}

export async function readAccount(input: { app: ProviderApp; accessToken: string; grantedScopes: string[]; externalId: string }): Promise<ProviderAccount> {
  if (!ACCOUNT_ID.test(input.externalId)) {
    throw new AdsProviderError({ kind: "validation", code: "ADS_ACCOUNT_ID_INVALID", outcome: "not_sent", retryable: false, fieldPaths: [] });
  }
  const client = createMetaGraphClient({ accessToken: input.accessToken, appSecret: input.app.clientSecret });
  const { data } = await client.get(`/${input.externalId}`, { fields: AD_ACCOUNT_FIELDS }, accountSchema);
  return mapAccount(data, input.grantedScopes);
}

export const metaAccounts: Pick<AdsConnect, "listAccounts" | "readAccount"> = { listAccounts, readAccount };
