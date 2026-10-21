// uLiquid Desk adapter (workflow B): reads Desk's own Customer Context API
// (`GET /integrations/v1/customers/:externalUserId/context`, contract 1.0,
// uliquid-desk docs/reference/customer-context-api.md) and translates it into
// Orbit's customer context v1. Embedded after shared.js into the adapter's
// Code node. Only allowlisted fields are copied; limits, exchanges and
// everything else Desk returns stay in n8n.

import {
  amountOf,
  applyInclude,
  contextHead,
  labelOf,
  problem,
  PRODUCT_TIMEOUT_MS,
  productUrl,
  retryAfter,
  timeOf,
  transportFailure,
} from "./shared.js";

export const DESK_SYSTEM = "uliquid-desk";
const DESK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The lookup URL for a Desk user id, or null when it cannot be a Desk id. */
export function deskUrl(baseUrl, id) {
  const base = productUrl(baseUrl);
  if (!base || !DESK_ID.test(id)) return null;
  return `${base}/integrations/v1/customers/${encodeURIComponent(id)}/context`;
}

const STATUS = { active: "active", grace: "past_due", expired: "expired", none: "none" };
const REASON = {
  not_in_plan: "not_in_plan",
  temporarily_disabled: "other",
  account_deactivated: "other",
};

function subscriptionOf(s) {
  const status = STATUS[s.status] || "unknown";
  const period = s.currentPeriod || null;
  // Desk terms are prepaid and never renew automatically: an active term
  // without a booked follow-up ends with its access window.
  let cancellation = { state: "none", requestedAt: null, effectiveAt: null };
  if (status === "expired")
    cancellation = {
      state: "effective",
      requestedAt: null,
      effectiveAt: timeOf(s.lastPeriod && s.lastPeriod.endsAt),
    };
  else if ((status === "active" || status === "past_due") && s.renewal && s.renewal.cancelAtPeriodEnd)
    cancellation = { state: "scheduled", requestedAt: null, effectiveAt: timeOf(s.accessEndsAt) };
  return {
    status,
    plan:
      s.plan && typeof s.plan.code === "string"
        ? { key: s.plan.code, name: labelOf(s.plan.name, s.plan.code) }
        : null,
    startedAt: null,
    currentPeriodStart: timeOf(period && period.startsAt),
    currentPeriodEnd: timeOf(period && period.endsAt),
    trialEndsAt: null,
    cancellation,
  };
}

function entitlementsOf(features, source) {
  return (features.items || []).slice(0, 100).map((item) => {
    const granted = item.available === true;
    return {
      key: String(item.key),
      label: labelOf(item.title, String(item.key)),
      state: granted ? "granted" : item.available === false ? "denied" : "unknown",
      source: granted ? (source === "admin_grant" ? "override" : "plan") : null,
      reason: granted ? null : REASON[item.reason] || "unknown",
      expiresAt: null,
    };
  });
}

function usageOf(credits) {
  const enforced = credits.enforced === true;
  const available = amountOf(credits.available);
  const items = [
    {
      key: "ai_credits",
      label: "AI credits",
      unit: "credits",
      period: "billing_period",
      // A balance, not a quota: no fixed limit. Credits are only spent while
      // Desk enforces them.
      limit: null,
      used: amountOf(credits.usage && credits.usage.thisMonth),
      remaining: enforced ? available : null,
      unlimited: enforced ? false : true,
      resetsAt: timeOf(credits.resets && credits.resets.nextMonthlyGrantAt),
    },
  ];
  const limits = credits.limits || {};
  const usage = credits.usage || {};
  const resets = credits.resets || {};
  for (const [key, period, limitValue, usedValue, resetsAt] of [
    ["ai_credits.daily_limit", "day", limits.daily, usage.today, resets.dailyUsageResetsAt],
    ["ai_credits.monthly_limit", "month", limits.monthly, usage.thisMonth, resets.monthlyUsageResetsAt],
  ]) {
    const limit = amountOf(limitValue);
    if (limit === null) continue;
    const used = amountOf(usedValue);
    items.push({
      key,
      label: period === "day" ? "AI credits per day" : "AI credits per month",
      unit: "credits",
      period,
      limit,
      used,
      remaining: used === null ? null : Math.max(limit - used, 0),
      unlimited: false,
      resetsAt: timeOf(resetsAt),
    });
  }
  return items;
}

/** Orbit's answer for a Desk HTTP response to `request`. */
export function mapDeskResponse(request, response, generatedAt) {
  const id = request.requestId;
  const status = response && response.statusCode;
  const body = response && response.body;
  if (status === 404) return problem("customer_not_found", id);
  if (status === 400) return problem("customer_not_found", id);
  if (status === 403) return problem("access_denied", id);
  if (status === 429) return problem("rate_limited", id, retryAfter(response.headers));
  if (status === 504) return problem("upstream_timeout", id);
  if (status !== 200) return problem("service_unavailable", id, retryAfter(response && response.headers));
  if (
    !body ||
    body.contractVersion !== "1.0" ||
    !body.customer ||
    body.customer.externalUserId !== request.subject.id ||
    !body.subscription ||
    !body.features ||
    !body.aiCredits
  )
    return problem("service_unavailable", id);
  const context = {
    ...contextHead(
      request,
      DESK_SYSTEM,
      body.customer.accountStatus === "deactivated" ? "suspended" : "active",
    ),
    subscription: subscriptionOf(body.subscription),
    entitlements: entitlementsOf(body.features, body.subscription.source),
    usage: usageOf(body.aiCredits),
    freshness: {
      generatedAt,
      dataAsOf: timeOf(body.generatedAt),
      maxAgeSeconds: 60,
      availability: { subscription: "available", entitlements: "available", usage: "available" },
    },
  };
  return { status: 200, body: applyInclude(context, request.include) };
}

/**
 * Workflow B: one lookup against Desk. `env` holds `CC_DESK_BASE_URL` and
 * `CC_DESK_TOKEN` (Desk's `dctx_` client token); `httpRequest` is n8n's
 * `this.helpers.httpRequest`. Ids Desk cannot have never leave n8n.
 */
export async function runDeskAdapter({ request, env, httpRequest, now }) {
  if (!DESK_ID.test(request.subject.id)) return problem("customer_not_found", request.requestId);
  const url = deskUrl(env.CC_DESK_BASE_URL, request.subject.id);
  const token = String(env.CC_DESK_TOKEN || "");
  if (!url || token.length < 32 || /\s/.test(token))
    return problem("service_unavailable", request.requestId);
  let response;
  try {
    response = await httpRequest({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      timeout: PRODUCT_TIMEOUT_MS,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
      json: true,
    });
  } catch (error) {
    return transportFailure(request, error);
  }
  return mapDeskResponse(request, response, now().toISOString());
}
