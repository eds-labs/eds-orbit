import { z } from "zod";

/**
 * Universal Customer Context, contract v1 (ADR 0011, docs/CUSTOMER_CONTEXT.md).
 *
 * A provider (a product directly, or n8n in front of it) answers Orbit's
 * `customer_context.read` lookup with a product-neutral snapshot of one
 * verified customer: subscription, effective entitlements and usage limits.
 * These zod schemas are the source of truth; the JSON Schemas and the
 * provider OpenAPI document under `packages/schemas/contracts/customer-context/v1/`
 * are generated from them (`pnpm contract:customer-context`).
 *
 * Every object is strict: a field the contract does not list is a contract
 * violation, never silently accepted. This is the field allowlist that keeps
 * payment, trading and household data out of Orbit.
 */

export const CUSTOMER_CONTEXT_SCHEMA_VERSION = "1.0";
/** Versions this Orbit understands, newest first. */
export const CUSTOMER_CONTEXT_VERSIONS = ["1.0"] as const;
/** Provider path below the integration's base URL. */
export const CUSTOMER_CONTEXT_PATH = "/v1/customer-context/lookup";

/** Transport limits every consumer and provider of v1 respects. */
export const CUSTOMER_CONTEXT_LIMITS = {
  /** Largest request or response body, in bytes. */
  maxBodyBytes: 64 * 1024,
  /** Orbit's default deadline for one lookup, end to end. */
  defaultTimeoutMs: 4_000,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 8_000,
  /** Budget a gateway (n8n) leaves for the product call. */
  gatewayUpstreamTimeoutMs: 2_500,
  /** Accepted clock skew of a signed request. */
  signatureToleranceSeconds: 300,
  maxEntitlements: 100,
  maxUsage: 50,
} as const;

const version = z.enum(CUSTOMER_CONTEXT_VERSIONS);
const timestamp = z.iso
  .datetime({ offset: true })
  .describe("RFC 3339 timestamp with offset.");
const optionalTimestamp = timestamp.nullable();
const slug = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,62}$/)
  .describe("Lower-case system identifier, e.g. `example-saas`.");
const key = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.:-]{0,127}$/)
  .describe(
    "Opaque, stable key chosen by the provider. Orbit never interprets it.",
  );
const label = z
  .string()
  .min(1)
  .max(120)
  .describe("Human-readable display text.");
const externalId = z
  .string()
  .regex(/^[^\u0000-\u001f\u007f]{1,200}$/)
  .describe(
    "The product's own user id, exactly as it signs it for the Orbit widget.",
  );
const amount = z
  .number()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .nullable()
  .describe("Non-negative quantity, or null when unknown. null never means 0.");

export const customerContextSection = z.enum([
  "subscription",
  "entitlements",
  "usage",
]);

export const customerContextRequest = z
  .object({
    schemaVersion: version,
    requestId: z
      .uuid()
      .describe("Unique per lookup; echoed in X-Orbit-Request-Id."),
    requestedAt: timestamp,
    integrationId: z
      .uuid()
      .describe(
        "Opaque id of the Orbit integration; selects the provider's routing.",
      ),
    acceptVersions: z.array(version).min(1).max(5),
    subject: z
      .object({
        type: z.literal("external_user_id"),
        id: externalId,
        verification: z
          .object({
            method: z
              .literal("widget_hmac")
              .describe(
                "The product's backend signed this user id for the Orbit widget.",
              ),
            verifiedAt: timestamp.describe(
              "When Orbit verified the link to this user id.",
            ),
          })
          .strict(),
      })
      .strict(),
    purpose: z.literal("support"),
    include: z
      .array(customerContextSection)
      .min(1)
      .max(3)
      .optional()
      .describe("Sections to return; all when absent."),
  })
  .strict()
  .meta({
    title: "CustomerContextRequest",
    description:
      "Orbit's lookup of one verified customer. Carries no e-mail, name or Orbit tenant id.",
  });

export const sectionAvailability = z
  .enum(["available", "unavailable", "not_applicable", "not_requested"])
  .describe(
    "available: the section holds data. unavailable: the provider could not read it now. not_applicable: the product has no such concept. not_requested: excluded by `include`.",
  );

export const customerSubscription = z
  .object({
    status: z.enum([
      "trialing",
      "active",
      "past_due",
      "paused",
      "canceled",
      "expired",
      "none",
      "unknown",
    ]),
    plan: z.object({ key, name: label }).strict().nullable(),
    startedAt: optionalTimestamp,
    currentPeriodStart: optionalTimestamp,
    currentPeriodEnd: optionalTimestamp.describe(
      "End of the paid or trial validity.",
    ),
    trialEndsAt: optionalTimestamp,
    cancellation: z
      .object({
        state: z
          .enum(["none", "scheduled", "effective", "unknown"])
          .describe(
            "scheduled: ends at effectiveAt (e.g. at period end). effective: already ended.",
          ),
        requestedAt: optionalTimestamp,
        effectiveAt: optionalTimestamp,
      })
      .strict(),
  })
  .strict();

export const customerEntitlement = z
  .object({
    key,
    label,
    state: z
      .enum(["granted", "denied", "unknown"])
      .describe("The effective state for this customer now."),
    source: z
      .enum(["plan", "addon", "trial", "override", "promotion", "unknown"])
      .nullable(),
    reason: z
      .enum([
        "not_in_plan",
        "plan_inactive",
        "limit_reached",
        "disabled_by_admin",
        "region_restricted",
        "other",
        "unknown",
      ])
      .nullable()
      .describe("Why a feature is denied; null when granted."),
    expiresAt: optionalTimestamp,
  })
  .strict();

export const customerUsage = z
  .object({
    key,
    label,
    unit: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,31}$/)
      .describe("e.g. credits, requests, seats."),
    period: z.enum([
      "day",
      "week",
      "month",
      "year",
      "billing_period",
      "lifetime",
      "unknown",
    ]),
    limit: amount,
    used: amount,
    remaining: amount,
    unlimited: z
      .boolean()
      .nullable()
      .describe("true: no limit applies. null: unknown."),
    resetsAt: optionalTimestamp.describe(
      "Next reset, or null when unknown or never.",
    ),
  })
  .strict();

export const customerContext = z
  .object({
    schemaVersion: version,
    source: z.object({ system: slug, integrationId: z.uuid() }).strict(),
    customer: z
      .object({
        externalRef: z
          .object({ type: z.literal("external_user_id"), id: externalId })
          .strict(),
        accountStatus: z.enum(["active", "suspended", "closed", "unknown"]),
      })
      .strict(),
    subscription: customerSubscription
      .nullable()
      .describe(
        "null exactly when freshness.availability.subscription is not `available`.",
      ),
    entitlements: z
      .array(customerEntitlement)
      .max(CUSTOMER_CONTEXT_LIMITS.maxEntitlements)
      .nullable()
      .describe(
        "null exactly when freshness.availability.entitlements is not `available`.",
      ),
    usage: z
      .array(customerUsage)
      .max(CUSTOMER_CONTEXT_LIMITS.maxUsage)
      .nullable()
      .describe(
        "null exactly when freshness.availability.usage is not `available`.",
      ),
    freshness: z
      .object({
        generatedAt: timestamp,
        dataAsOf: optionalTimestamp.describe(
          "Age of the underlying product data, when known.",
        ),
        maxAgeSeconds: z
          .int()
          .min(0)
          .max(3600)
          .describe("How long Orbit may show this snapshot."),
        availability: z
          .object({
            subscription: sectionAvailability,
            entitlements: sectionAvailability,
            usage: sectionAvailability,
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const section of customerContextSection.options) {
      const present = value[section] !== null;
      const available = value.freshness.availability[section] === "available";
      if (present !== available)
        ctx.addIssue({
          code: "custom",
          path: [section],
          message: `${section} must be present exactly when its availability is "available"`,
        });
    }
    for (const section of ["entitlements", "usage"] as const) {
      const keys = (value[section] ?? []).map((item) => item.key);
      if (new Set(keys).size !== keys.length)
        ctx.addIssue({
          code: "custom",
          path: [section],
          message: "duplicate key",
        });
    }
    value.usage?.forEach((item, index) => {
      if (
        item.unlimited === true &&
        (item.limit !== null || item.remaining !== null)
      )
        ctx.addIssue({
          code: "custom",
          path: ["usage", index],
          message: "an unlimited quota has no limit and no remaining amount",
        });
    });
  })
  .meta({
    title: "CustomerContext",
    description:
      "Product-neutral snapshot of one verified customer. Unknown values are null; a null amount is never 0.",
  });

/** Problem codes a provider answers with, and their HTTP status. */
export const CUSTOMER_CONTEXT_PROBLEMS = {
  invalid_request: 400,
  unsupported_version: 400,
  unauthenticated: 401,
  access_denied: 403,
  customer_not_found: 404,
  identity_not_verified: 422,
  rate_limited: 429,
  service_unavailable: 503,
  upstream_timeout: 504,
} as const;
export type CustomerContextProblemCode = keyof typeof CUSTOMER_CONTEXT_PROBLEMS;
const problemCodes = Object.keys(CUSTOMER_CONTEXT_PROBLEMS) as [
  CustomerContextProblemCode,
  ...CustomerContextProblemCode[],
];

export const customerContextProblem = z
  .object({
    type: z.string().min(1).max(300).describe("RFC 9457 problem type URI."),
    title: z.string().min(1).max(200),
    status: z.int().min(400).max(599),
    code: z.enum(problemCodes),
    detail: z
      .string()
      .max(500)
      .optional()
      .describe("Short diagnostic text. Never customer data."),
    requestId: z.uuid().optional(),
    retryAfterSeconds: z.int().min(1).max(3600).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (CUSTOMER_CONTEXT_PROBLEMS[value.code] !== value.status)
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: `${value.code} is answered with HTTP ${CUSTOMER_CONTEXT_PROBLEMS[value.code]}`,
      });
  })
  .meta({
    title: "CustomerContextProblem",
    description: "RFC 9457 problem details (application/problem+json).",
  });

/**
 * What Orbit makes of one lookup, for the UI and the agents. Decided
 * locally (`identity_unverified`, `forbidden`) whenever no call may be made.
 */
export const customerContextResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), context: customerContext }).strict(),
  z.object({ status: z.literal("not_found") }).strict(),
  z
    .object({
      status: z.literal("identity_unverified"),
      reason: z.enum(["no_verified_identity", "provider_rejected"]),
    })
    .strict(),
  z
    .object({
      status: z.literal("forbidden"),
      reason: z.enum([
        "permission",
        "module_disabled",
        "feature_disabled",
        "no_integration",
        "provider_denied",
      ]),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      reason: z.enum([
        "timeout",
        "network",
        "provider_error",
        "invalid_response",
        "misconfigured",
        "circuit_open",
        "rate_limited",
      ]),
      retryAfterSeconds: z.int().min(1).max(3600).nullable(),
    })
    .strict(),
]);

export type CustomerContextRequest = z.infer<typeof customerContextRequest>;
export type CustomerContext = z.infer<typeof customerContext>;
export type CustomerContextProblem = z.infer<typeof customerContextProblem>;
export type CustomerContextResult = z.infer<typeof customerContextResult>;

const unavailable = (
  reason: Extract<CustomerContextResult, { status: "unavailable" }>["reason"],
  retryAfterSeconds: number | null = null,
): CustomerContextResult => ({
  status: "unavailable",
  reason,
  retryAfterSeconds,
});

/**
 * Interprets a provider's HTTP answer to `request`. Pure: the caller does
 * the transport (deadline, size cap) and passes the parsed JSON body, or
 * `undefined` when the body was not JSON. A response for another
 * integration or another customer is rejected as `invalid_response`.
 */
export function interpretCustomerContextResponse(
  request: CustomerContextRequest,
  httpStatus: number,
  body: unknown,
): CustomerContextResult {
  if (httpStatus === 200) {
    const parsed = customerContext.safeParse(body);
    if (!parsed.success) return unavailable("invalid_response");
    const context = parsed.data;
    if (
      !request.acceptVersions.includes(context.schemaVersion) ||
      context.source.integrationId !== request.integrationId ||
      context.customer.externalRef.id !== request.subject.id
    )
      return unavailable("invalid_response");
    return { status: "ok", context };
  }
  const problem = customerContextProblem.safeParse(body);
  const code = problem.success ? problem.data.code : undefined;
  const retryAfter = problem.success
    ? (problem.data.retryAfterSeconds ?? null)
    : null;
  if (code === "customer_not_found" && httpStatus === 404)
    return { status: "not_found" };
  if (code === "identity_not_verified" && httpStatus === 422)
    return { status: "identity_unverified", reason: "provider_rejected" };
  if (code === "access_denied" && httpStatus === 403)
    return { status: "forbidden", reason: "provider_denied" };
  if (httpStatus === 429) return unavailable("rate_limited", retryAfter);
  if (httpStatus === 504) return unavailable("timeout", retryAfter);
  if (httpStatus >= 500) return unavailable("provider_error", retryAfter);
  if ([400, 401, 403, 404, 405, 406, 415].includes(httpStatus))
    return unavailable("misconfigured");
  return unavailable(problem.success ? "provider_error" : "invalid_response");
}
