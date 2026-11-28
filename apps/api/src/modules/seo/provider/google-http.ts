import { createHash } from "node:crypto";
import { z } from "zod";
import { DomainError } from "../../../platform/shared.ts";
import {
  seoDimensions,
  type SeoPerformance,
  type SeoPerformanceInput,
  type SeoProperty,
} from "./types.ts";

export const GOOGLE_SEARCH_CONSOLE_SCOPE =
  "https://www.googleapis.com/auth/webmasters.readonly";

const tokenEndpoint = "https://oauth2.googleapis.com/token";
const sitesEndpoint = "https://www.googleapis.com/webmasters/v3/sites";
const timeoutMs = 10_000;
const googleFailure = () => new DomainError("SEO_GOOGLE_REQUEST_FAILED", 502);
const reconnect = () =>
  new DomainError("SEO_CONNECTION_RECONNECT_REQUIRED", 409);
const rateLimited = () => new DomainError("SEO_PROVIDER_RATE_LIMITED", 429);
const quotaReasons = new Set([
  "quotaExceeded",
  "rateLimitExceeded",
  "dailyLimitExceeded",
  "userRateLimitExceeded",
]);

const providerError = z.object({
  error: z.object({
    status: z.string().optional(),
    errors: z.array(z.object({ reason: z.string() })).optional(),
  }),
});

async function rejectQuota(response: Response) {
  if (response.status !== 403) return;
  const result = providerError.safeParse(
    await response.json().catch(() => null),
  );
  if (
    result.success &&
    (result.data.error.status === "RESOURCE_EXHAUSTED" ||
      result.data.error.errors?.some(({ reason }) => quotaReasons.has(reason)))
  )
    throw rateLimited();
}

type OAuthClient = { clientId: string; clientSecret: string };

async function request(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => {
    throw googleFailure();
  });
  if (response.status === 429) throw rateLimited();
  return response;
}

async function decode<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw googleFailure();
  return parsed.data;
}

const tokenSchema = z.object({
  access_token: z.string().min(1).max(8192),
  refresh_token: z.string().min(1).max(8192).optional(),
  scope: z.string().max(8192).optional(),
});

async function requestTokens(
  app: OAuthClient,
  fields: Record<string, string>,
  refreshing: boolean,
) {
  const response = await request(tokenEndpoint, {
    method: "POST",
    body: new URLSearchParams({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      ...fields,
    }),
  });
  if (!response.ok) {
    if (refreshing && response.status === 400) {
      const error = (await response.json().catch(() => null)) as {
        error?: unknown;
      } | null;
      if (error?.error === "invalid_grant") throw reconnect();
    }
    throw new DomainError("SEO_GOOGLE_OAUTH_FAILED", 502);
  }
  const tokens = await decode(response, tokenSchema);
  if (
    tokens.scope &&
    !tokens.scope.split(/\s+/).includes(GOOGLE_SEARCH_CONSOLE_SCOPE)
  )
    throw new DomainError("SEO_GOOGLE_SCOPE_MISSING", 409);
  return tokens;
}

export async function exchangeGoogleCode(
  app: OAuthClient,
  input: { code: string; verifier: string; redirectUri: string },
) {
  const tokens = await requestTokens(
    app,
    {
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
    },
    false,
  );
  if (!tokens.refresh_token)
    throw new DomainError("SEO_GOOGLE_OFFLINE_ACCESS_REQUIRED", 409);
  return tokens.refresh_token;
}

export async function refreshGoogleToken(
  app: OAuthClient,
  refreshToken: string,
) {
  const tokens = await requestTokens(
    app,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    true,
  );
  return tokens.access_token;
}

const refreshes = new Map<string, Promise<string>>();

/** Coalesce overlapping reads for the same authorized Orbit connection and credential. */
export function prepareGoogleTokenRefresh(
  connectionId: string,
  app: OAuthClient,
  refreshToken: string,
) {
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        connectionId,
        app.clientId,
        app.clientSecret,
        refreshToken,
      ]),
    )
    .digest("hex");
  return () => {
    const existing = refreshes.get(key);
    if (existing) return existing;
    const task = refreshGoogleToken(app, refreshToken).finally(() => {
      refreshes.delete(key);
    });
    refreshes.set(key, task);
    return task;
  };
}

function bearer(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

function isGoogleProperty(value: string) {
  if (value.startsWith("sc-domain:")) {
    const domain = value.slice("sc-domain:".length);
    return (
      domain.length <= 253 &&
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
        domain,
      )
    );
  }
  if (!/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f]/u.test(value))
    return false;
  const url = URL.parse(value);
  return Boolean(url && url.hostname && !url.username && !url.password);
}
const googlePropertyId = z.string().min(1).max(2048).refine(isGoogleProperty);
const readablePermission = new Set([
  "siteOwner",
  "siteFullUser",
  "siteRestrictedUser",
]);
const propertiesSchema = z.object({
  siteEntry: z
    .array(z.object({ siteUrl: z.string(), permissionLevel: z.string() }))
    .default([]),
});

export async function listGoogleProperties(
  accessToken: string,
): Promise<SeoProperty[]> {
  const response = await request(sitesEndpoint, {
    headers: bearer(accessToken),
  });
  if (response.status === 401) throw reconnect();
  await rejectQuota(response);
  if (!response.ok) throw googleFailure();
  const { siteEntry } = await decode(response, propertiesSchema);
  const unique = new Map<string, SeoProperty>();
  for (const { siteUrl, permissionLevel } of siteEntry) {
    if (
      !readablePermission.has(permissionLevel) ||
      !googlePropertyId.safeParse(siteUrl).success
    )
      continue;
    unique.set(siteUrl, {
      externalId: siteUrl,
      label: siteUrl.replace(/^sc-domain:/, ""),
    });
  }
  return [...unique.values()];
}

const searchInputSchema = z.object({
  externalId: googlePropertyId,
  startDate: z.iso.date(),
  endDate: z.iso.date(),
  dimension: z.enum(seoDimensions).optional(),
  limit: z.int().min(1).max(25_000).optional(),
});
const searchSchema = z.object({
  rows: z
    .array(
      z.object({
        keys: z.array(z.string().max(16_384)).max(1).default([]),
        clicks: z.number().nonnegative(),
        impressions: z.number().nonnegative(),
        ctr: z.number().min(0).max(1),
        position: z.number().nonnegative(),
      }),
    )
    .default([]),
});

export function prepareGoogleQuery(raw: SeoPerformanceInput) {
  const parsed = searchInputSchema.safeParse(raw);
  if (!parsed.success || parsed.data.startDate > parsed.data.endDate)
    throw new DomainError("SEO_REPORT_INPUT_INVALID", 400);
  const {
    externalId,
    startDate,
    endDate,
    dimension,
    limit = 100,
  } = parsed.data;
  const url = `${sitesEndpoint}/${encodeURIComponent(externalId)}/searchAnalytics/query`;
  return async (accessToken: string): Promise<SeoPerformance> => {
    const response = await request(url, {
      method: "POST",
      headers: { ...bearer(accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({
        startDate,
        endDate,
        ...(dimension ? { dimensions: [dimension] } : {}),
        rowLimit: limit,
        type: "web",
        dataState: "final",
      }),
    });
    if (response.status === 401) throw reconnect();
    await rejectQuota(response);
    if (response.status === 403 || response.status === 404)
      throw new DomainError("SEO_PROPERTY_INACCESSIBLE", 409);
    if (!response.ok) throw googleFailure();
    const { rows } = await decode(response, searchSchema);
    if (
      rows.length > limit ||
      rows.some((row) => row.keys.length !== (dimension ? 1 : 0))
    )
      throw googleFailure();
    return { rows };
  };
}
