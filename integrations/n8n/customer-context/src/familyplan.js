// FamilyPlan adapter (workflow C): reads FamilyPlan's read-only Edge Function
// `support-customer-context` (familyplan contracts/support/
// customer-context-v1.schema.json) and translates it into Orbit's customer
// context v1. Embedded after shared.js into the adapter's Code node.
//
// FamilyPlan bills per family. The function already reduces all families of
// the account to the most favourable access ("Günstigster Zugang", Mario
// 2026-10-21) and returns counts only: no family name, member, child,
// location or purchase data reaches n8n or Orbit.

import {
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

export const FAMILYPLAN_SYSTEM = "familyplan";
// The id FamilyPlan signs for the widget: `familyplan:<auth user uuid>`.
const FAMILYPLAN_ID = /^familyplan:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCESS = ["active", "manual", "trial", "grace_period", "expired", "none"];
const STATUS = {
  active: "active",
  manual: "active",
  trial: "trialing",
  grace_period: "past_due",
  expired: "expired",
  none: "none",
};

function subscriptionOf(access) {
  const status = STATUS[access.status];
  const current = status !== "expired" && status !== "none";
  const expiresAt = current ? timeOf(access.expiresAt) : null;
  return {
    status,
    plan:
      current && typeof access.planKey === "string"
        ? { key: access.planKey, name: labelOf(access.planTitle, access.planKey) }
        : null,
    startedAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: status === "trialing" ? null : expiresAt,
    trialEndsAt: status === "trialing" ? expiresAt : null,
    // Store subscriptions renew unless cancelled in the store; FamilyPlan does
    // not know about a cancellation before the store reports the expiry.
    cancellation: {
      state: status === "expired" ? "effective" : status === "none" ? "none" : "unknown",
      requestedAt: null,
      effectiveAt: null,
    },
  };
}

function entitlementsOf(features, access) {
  const source =
    access.status === "manual" ? "override" : access.status === "trial" ? "trial" : "plan";
  return features.slice(0, 100).map((feature) => ({
    key: String(feature.key),
    label: labelOf(feature.title, String(feature.key)),
    state: feature.allowed ? "granted" : "denied",
    source: feature.allowed ? source : null,
    reason: feature.allowed ? null : access.status === "expired" ? "plan_inactive" : "not_in_plan",
    expiresAt: null,
  }));
}

function usageOf(customer) {
  // Not a quota: the number of families the account belongs to, so an agent
  // can tell that Premium is decided per family.
  return [
    ["families", "Families", customer.familyCount],
    ["families.premium", "Families with Premium", customer.premiumFamilyCount],
  ].map(([key, label, used]) => ({
    key,
    label,
    unit: "families",
    period: "unknown",
    limit: null,
    used,
    remaining: null,
    unlimited: null,
    resetsAt: null,
  }));
}

const count = (v) => Number.isInteger(v) && v >= 0 && v <= 1000;

function valid(body, request) {
  if (!body || body.contractVersion !== "1.0" || !body.customer || !body.access) return false;
  const { customer, access, features } = body;
  return (
    customer.externalUserId === request.subject.id &&
    (customer.accountStatus === "active" || customer.accountStatus === "suspended") &&
    count(customer.familyCount) &&
    count(customer.premiumFamilyCount) &&
    customer.premiumFamilyCount <= customer.familyCount &&
    ACCESS.includes(access.status) &&
    Array.isArray(features) &&
    features.every(
      (f) => f && typeof f.key === "string" && /^[a-z0-9_]{1,64}$/.test(f.key) && typeof f.allowed === "boolean",
    )
  );
}

/** Orbit's answer for a FamilyPlan HTTP response to `request`. */
export function mapFamilyPlanResponse(request, response, generatedAt) {
  const id = request.requestId;
  const status = response && response.statusCode;
  const body = response && response.body;
  if (status === 404 || status === 400) return problem("customer_not_found", id);
  if (status === 403) return problem("access_denied", id);
  if (status === 429) return problem("rate_limited", id, retryAfter(response.headers));
  if (status === 504) return problem("upstream_timeout", id);
  if (status !== 200 || !valid(body, request)) return problem("service_unavailable", id);
  const context = {
    ...contextHead(request, FAMILYPLAN_SYSTEM, body.customer.accountStatus),
    subscription: subscriptionOf(body.access),
    entitlements: entitlementsOf(body.features, body.access),
    usage: usageOf(body.customer),
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
 * Workflow C: one lookup against FamilyPlan. `env` holds
 * `CC_FAMILYPLAN_FUNCTION_URL` (the Edge Function URL) and
 * `CC_FAMILYPLAN_TOKEN` (its service token); `httpRequest` is n8n's
 * `this.helpers.httpRequest`.
 */
export async function runFamilyPlanAdapter({ request, env, httpRequest, now }) {
  // Orbit's connection check (reserved subject) goes through, so it proves
  // the token as well: FamilyPlan answers it with 400 after authentication.
  const check = request.subject.id === "orbit-connection-check";
  if (!check && !FAMILYPLAN_ID.test(request.subject.id))
    return problem("customer_not_found", request.requestId);
  const url = productUrl(env.CC_FAMILYPLAN_FUNCTION_URL);
  const token = String(env.CC_FAMILYPLAN_TOKEN || "");
  if (!url || token.length < 32 || /\s/.test(token))
    return problem("service_unavailable", request.requestId);
  let response;
  try {
    response = await httpRequest({
      method: "POST",
      url,
      headers: { "x-customer-context-token": token, accept: "application/json" },
      body: { externalUserId: request.subject.id },
      timeout: PRODUCT_TIMEOUT_MS,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
      json: true,
    });
  } catch (error) {
    return transportFailure(request, error);
  }
  return mapFamilyPlanResponse(request, response, now().toISOString());
}
