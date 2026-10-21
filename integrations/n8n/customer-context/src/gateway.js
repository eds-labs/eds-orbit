// Gateway authentication and routing (workflow A). Embedded after shared.js
// into the gateway's "Authenticate" Code node. Every refusal before a valid
// signature is the same generic 401, so a caller learns nothing about which
// integrations exist.

import {
  MAX_BODY_BYTES,
  problem,
  SIGNATURE_TOLERANCE_SECONDS,
  validateRequest,
} from "./shared.js";

/** Product adapters the gateway may route to: adapter key → sub-workflow id. */
export const ADAPTERS = {
  "uliquid-desk": "CcAdapterUliquidDesk01",
  familyplan: "CcAdapterFamilyPlan001",
};

/**
 * Integrations from `CC_GATEWAY_INTEGRATIONS` (JSON array): each binds one
 * Orbit integration id to one adapter, the SHA-256 of its bearer token and
 * its signing secret. Invalid entries are dropped; an invalid document is [].
 */
export function parseIntegrations(raw) {
  let list;
  try {
    list = JSON.parse(raw || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.filter(
    (entry) =>
      entry &&
      typeof entry.integrationId === "string" &&
      /^[0-9a-f-]{36}$/i.test(entry.integrationId) &&
      typeof entry.adapter === "string" &&
      typeof entry.tokenSha256 === "string" &&
      /^[0-9a-f]{64}$/.test(entry.tokenSha256) &&
      typeof entry.signingSecret === "string" &&
      entry.signingSecret.length >= 32,
  );
}

function constantEqual(crypto, a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Checks one webhook call. Returns the validated request and the adapter's
 * workflow id, or `{ ok: false, status, body }` with a v1 problem.
 */
export function authenticate({ raw, headers, now, integrations, crypto }) {
  const denied = { ok: false, ...problem("unauthenticated") };
  if (typeof raw !== "string" || !raw || Buffer.byteLength(raw) > MAX_BODY_BYTES)
    return { ok: false, ...problem("invalid_request") };
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, ...problem("invalid_request") };
  }
  const h = headers || {};
  const integration = integrations.find(
    (entry) => body && typeof body === "object" && entry.integrationId === body.integrationId,
  );
  if (!integration) return denied;
  const auth = String(h.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  if (!token || !constantEqual(crypto, tokenHash, integration.tokenSha256)) return denied;
  const timestamp = String(h["x-orbit-timestamp"] || "");
  if (!/^\d{10}$/.test(timestamp)) return denied;
  if (Math.abs(now / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return denied;
  const expected =
    "v1=" + crypto.createHmac("sha256", integration.signingSecret).update(`${timestamp}.${raw}`).digest("hex");
  if (!constantEqual(crypto, String(h["x-orbit-signature"] || ""), expected)) return denied;
  // Authenticated from here on: answers may name the request.
  const checked = validateRequest(body);
  if (!checked.ok) return { ok: false, ...problem(checked.code, body.requestId) };
  if (h["x-orbit-request-id"] !== checked.request.requestId)
    return { ok: false, ...problem("invalid_request", checked.request.requestId) };
  const adapterWorkflowId = Object.prototype.hasOwnProperty.call(ADAPTERS, integration.adapter)
    ? ADAPTERS[integration.adapter]
    : null;
  if (!adapterWorkflowId)
    return { ok: false, ...problem("service_unavailable", checked.request.requestId) };
  return { ok: true, adapter: integration.adapter, adapterWorkflowId, request: checked.request };
}
