// Customer context v1 (ADR 0011) for n8n Code nodes: request validation,
// problem details and the strict output check. Code nodes cannot import
// modules, so build.mjs embeds this file (without `export`) into every node
// that needs it. Plain JavaScript only; no dependencies.

export const SCHEMA_VERSION = "1.0";
export const MAX_BODY_BYTES = 64 * 1024;
export const SIGNATURE_TOLERANCE_SECONDS = 300;
export const PRODUCT_TIMEOUT_MS = 2500;

export const PROBLEMS = {
  invalid_request: [400, "Invalid request"],
  unsupported_version: [400, "Unsupported schema version"],
  unauthenticated: [401, "Unauthenticated"],
  access_denied: [403, "Access denied"],
  customer_not_found: [404, "Customer not found"],
  identity_not_verified: [422, "Identity not verified"],
  rate_limited: [429, "Too many requests"],
  service_unavailable: [503, "Service unavailable"],
  upstream_timeout: [504, "Upstream timeout"],
};

/** `{ status, body }` with an RFC 9457 problem for one of the v1 codes. */
export function problem(code, requestId, retryAfterSeconds) {
  const [status, title] = PROBLEMS[code];
  const body = {
    type: `urn:eds-orbit:customer-context:problem:${code}`,
    title,
    status,
    code,
  };
  if (typeof requestId === "string" && UUID.test(requestId))
    body.requestId = requestId;
  if (
    Number.isInteger(retryAfterSeconds) &&
    retryAfterSeconds >= 1 &&
    retryAfterSeconds <= 3600
  )
    body.retryAfterSeconds = retryAfterSeconds;
  return { status, body };
}

/** Seconds from a Retry-After header, or undefined. */
export function retryAfter(headers) {
  const value = Number(headers && (headers["retry-after"] ?? headers["Retry-After"]));
  return Number.isInteger(value) && value >= 1 ? Math.min(value, 3600) : undefined;
}

const UUID =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
const DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const SLUG = /^[a-z][a-z0-9-]{1,62}$/;
const KEY = /^[a-z0-9][a-z0-9_.:-]{0,127}$/;
const UNIT = /^[a-z][a-z0-9_]{0,31}$/;
const EXTERNAL_ID = /^[^\u0000-\u001f\u007f]{1,200}$/;
const SECTIONS = ["subscription", "entitlements", "usage"];

// A tiny strict schema checker: each check returns null or the failing path.
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const T = {
  string: (re, min = 0, max = Infinity) => (v) =>
    typeof v === "string" && v.length >= min && v.length <= max && (!re || re.test(v)),
  literal: (x) => (v) => v === x,
  oneOf: (...xs) => (v) => xs.includes(v),
  uuid: (v) => typeof v === "string" && UUID.test(v),
  datetime: (v) => typeof v === "string" && DATETIME.test(v) && !Number.isNaN(Date.parse(v)),
  int: (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max,
  amount: (v) =>
    v === null ||
    (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER),
  boolean: (v) => typeof v === "boolean",
  nullable: (f) => (v) => v === null || f(v),
};
function check(schema, value, path) {
  if (typeof schema === "function") return schema(value) ? null : path || "$";
  if (schema.nullable && value === null) return null;
  if (schema.array) {
    if (!Array.isArray(value)) return path || "$";
    if (value.length < (schema.min ?? 0) || value.length > (schema.max ?? Infinity)) return path || "$";
    for (let i = 0; i < value.length; i++) {
      const bad = check(schema.array, value[i], `${path}.${i}`);
      if (bad) return bad;
    }
    return null;
  }
  const shape = schema.object;
  if (!isObject(value)) return path || "$";
  for (const key of Object.keys(value))
    if (!(key in shape)) return `${path ? `${path}.` : ""}${key}`;
  for (const [key, sub] of Object.entries(shape)) {
    const optional = schema.optional && schema.optional.includes(key);
    if (!(key in value)) {
      if (optional) continue;
      return `${path ? `${path}.` : ""}${key}`;
    }
    const bad = check(sub, value[key], `${path ? `${path}.` : ""}${key}`);
    if (bad) return bad;
  }
  return null;
}

const REQUEST = {
  object: {
    schemaVersion: T.literal(SCHEMA_VERSION),
    requestId: T.uuid,
    requestedAt: T.datetime,
    integrationId: T.uuid,
    acceptVersions: { array: T.literal(SCHEMA_VERSION), min: 1, max: 5 },
    subject: {
      object: {
        type: T.literal("external_user_id"),
        id: T.string(EXTERNAL_ID),
        verification: {
          object: { method: T.literal("widget_hmac"), verifiedAt: T.datetime },
        },
      },
    },
    purpose: T.literal("support"),
    include: { array: T.oneOf(...SECTIONS), min: 1, max: 3 },
  },
  optional: ["include"],
};

/** The parsed request if it is a valid v1 request, else the problem code. */
export function validateRequest(body) {
  if (isObject(body)) {
    const accepted = Array.isArray(body.acceptVersions) ? body.acceptVersions : [];
    if (body.schemaVersion !== SCHEMA_VERSION || !accepted.includes(SCHEMA_VERSION)) {
      if (typeof body.schemaVersion === "string" && accepted.every((v) => typeof v === "string"))
        return { ok: false, code: "unsupported_version" };
    }
  }
  const bad = check(REQUEST, body, "");
  return bad ? { ok: false, code: "invalid_request", path: bad } : { ok: true, request: body };
}

const availability = T.oneOf("available", "unavailable", "not_applicable", "not_requested");
const optionalTime = T.nullable(T.datetime);
const CONTEXT = {
  object: {
    schemaVersion: T.literal(SCHEMA_VERSION),
    source: { object: { system: T.string(SLUG), integrationId: T.uuid } },
    customer: {
      object: {
        externalRef: {
          object: { type: T.literal("external_user_id"), id: T.string(EXTERNAL_ID) },
        },
        accountStatus: T.oneOf("active", "suspended", "closed", "unknown"),
      },
    },
    subscription: {
      nullable: true,
      object: {
        status: T.oneOf("trialing", "active", "past_due", "paused", "canceled", "expired", "none", "unknown"),
        plan: {
          nullable: true,
          object: { key: T.string(KEY), name: T.string(null, 1, 120) },
        },
        startedAt: optionalTime,
        currentPeriodStart: optionalTime,
        currentPeriodEnd: optionalTime,
        trialEndsAt: optionalTime,
        cancellation: {
          object: {
            state: T.oneOf("none", "scheduled", "effective", "unknown"),
            requestedAt: optionalTime,
            effectiveAt: optionalTime,
          },
        },
      },
    },
    entitlements: {
      nullable: true,
      array: {
        object: {
          key: T.string(KEY),
          label: T.string(null, 1, 120),
          state: T.oneOf("granted", "denied", "unknown"),
          source: T.nullable(T.oneOf("plan", "addon", "trial", "override", "promotion", "unknown")),
          reason: T.nullable(
            T.oneOf("not_in_plan", "plan_inactive", "limit_reached", "disabled_by_admin", "region_restricted", "other", "unknown"),
          ),
          expiresAt: optionalTime,
        },
      },
      max: 100,
    },
    usage: {
      nullable: true,
      array: {
        object: {
          key: T.string(KEY),
          label: T.string(null, 1, 120),
          unit: T.string(UNIT),
          period: T.oneOf("day", "week", "month", "year", "billing_period", "lifetime", "unknown"),
          limit: T.amount,
          used: T.amount,
          remaining: T.amount,
          unlimited: T.nullable(T.boolean),
          resetsAt: optionalTime,
        },
      },
      max: 50,
    },
    freshness: {
      object: {
        generatedAt: T.datetime,
        dataAsOf: optionalTime,
        maxAgeSeconds: T.int(0, 3600),
        availability: {
          object: { subscription: availability, entitlements: availability, usage: availability },
        },
      },
    },
  },
};

/**
 * Problems of a customer context for `request`: the v1 schema, its three
 * cross-field rules and the echo of integration and customer. Empty when
 * the context may be returned to Orbit.
 */
export function contextIssues(context, request) {
  const bad = check(CONTEXT, context, "");
  if (bad) return [`schema:${bad}`];
  const issues = [];
  for (const section of SECTIONS)
    if ((context[section] !== null) !== (context.freshness.availability[section] === "available"))
      issues.push(`availability:${section}`);
  for (const section of ["entitlements", "usage"]) {
    const keys = (context[section] || []).map((item) => item.key);
    if (new Set(keys).size !== keys.length) issues.push(`duplicate:${section}`);
  }
  (context.usage || []).forEach((item, i) => {
    if (item.unlimited === true && (item.limit !== null || item.remaining !== null))
      issues.push(`unlimited:usage.${i}`);
  });
  if (request) {
    if (context.source.integrationId !== request.integrationId) issues.push("echo:integration");
    if (context.customer.externalRef.id !== request.subject.id) issues.push("echo:customer");
    if (!request.acceptVersions.includes(context.schemaVersion)) issues.push("version");
  }
  if (JSON.stringify(context).length > MAX_BODY_BYTES) issues.push("size");
  return issues;
}

/** Sets the sections the request left out to null / `not_requested`. */
export function applyInclude(context, include) {
  if (!Array.isArray(include)) return context;
  for (const section of SECTIONS)
    if (!include.includes(section)) {
      context[section] = null;
      context.freshness.availability[section] = "not_requested";
    }
  return context;
}

/**
 * What the gateway answers: an adapter's valid context or problem, else a
 * generic `service_unavailable`. Never forwards anything off-contract.
 */
export function finalizeResponse(request, result) {
  const requestId = request && request.requestId;
  if (!result || typeof result !== "object") return problem("service_unavailable", requestId);
  if (result.status === 200)
    return contextIssues(result.body, request).length
      ? problem("service_unavailable", requestId)
      : { status: 200, body: result.body };
  const code = result.body && result.body.code;
  if (!(code in PROBLEMS) || PROBLEMS[code][0] !== result.status)
    return problem("service_unavailable", requestId);
  return problem(code, requestId, result.body.retryAfterSeconds);
}

/** Integer amount from a decimal string or number; null (unknown) otherwise, never 0 by default. */
export function amountOf(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !/^\d{1,16}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** ISO timestamp or null. */
export function timeOf(value) {
  return typeof value === "string" && DATETIME.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

/** Display text bounded to the contract's 120 characters, or a fallback. */
export function labelOf(value, fallback) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  return text || fallback;
}

/**
 * The configured product URL if it is HTTPS (plain HTTP only for loopback
 * stubs in local tests), else null: product credentials never leave over an
 * unencrypted public connection.
 */
export function productUrl(value) {
  // n8n's Code node sandbox has no global URL: a strict pattern instead. No
  // user info, query or fragment; host names, IPv4 or bracketed IPv6.
  const match = /^(https?):\/\/([A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:]{2,39}\])(:\d{1,5})?(\/[A-Za-z0-9._~%\/-]*)?$/.exec(
    String(value || ""),
  );
  if (!match) return null;
  const loopback = match[2] === "127.0.0.1" || match[2].toLowerCase() === "localhost";
  if (match[1] !== "https" && !loopback) return null;
  return `${match[1]}://${match[2]}${match[3] || ""}${(match[4] || "").replace(/\/+$/, "")}`;
}

/** Orbit's answer when a product call itself failed (timeout or network). */
export function transportFailure(request, error) {
  const text = `${(error && error.code) || ""} ${(error && error.message) || ""}`;
  return /timeout|ECONNABORTED|ETIMEDOUT/i.test(text)
    ? problem("upstream_timeout", request.requestId)
    : problem("service_unavailable", request.requestId);
}

/** The common head of a context for `request` from `system`. */
export function contextHead(request, system, accountStatus) {
  return {
    schemaVersion: SCHEMA_VERSION,
    source: { system, integrationId: request.integrationId },
    customer: {
      externalRef: { type: "external_user_id", id: request.subject.id },
      accountStatus,
    },
  };
}
