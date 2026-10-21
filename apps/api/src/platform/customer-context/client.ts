import { createHmac, randomUUID } from "node:crypto";
import {
  boundedFetch,
  ConnectorError,
  endpoint,
  type FetchLike,
} from "../../../../../packages/connectors/src/http.ts";
import {
  CUSTOMER_CONTEXT_LIMITS,
  CUSTOMER_CONTEXT_PATH,
  CUSTOMER_CONTEXT_SCHEMA_VERSION,
  CUSTOMER_CONTEXT_VERSIONS,
  interpretCustomerContextResponse,
  type CustomerContextRequest,
  type CustomerContextResult,
} from "../../../../../packages/schemas/src/customer-context.ts";

// The consumer side of `customer_context.read` (ADR 0011): one signed,
// synchronous lookup through the SSRF-safe transport, bounded by a deadline,
// a body cap, a per-integration concurrency cap and a circuit breaker. No
// retry and no storage: the caller gets a `CustomerContextResult` and
// decides what to show. Product-neutral; nothing here names a product.

/** One integration as the client needs it (from its connection row). */
export type CustomerContextTarget = {
  connectionId: string;
  baseUrl: string;
  timeoutMs: number;
  credential: { token: string; signingSecret: string };
};

export type CustomerContextSubject = { id: string; verifiedAt: Date };

export type CustomerContextLookup = {
  result: CustomerContextResult;
  durationMs: number;
};

/** `v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>` (provider OpenAPI). */
export function signCustomerContextBody(
  signingSecret: string,
  timestamp: string,
  body: string,
) {
  return `v1=${createHmac("sha256", signingSecret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** The lookup URL below an integration's base URL (HTTPS, no query). */
export function customerContextUrl(baseUrl: string) {
  const base = endpoint(baseUrl);
  return new URL(
    `${base.pathname.replace(/\/+$/, "")}${CUSTOMER_CONTEXT_PATH}`,
    base,
  );
}

/** Integration timeouts are clamped to the contract's bounds. */
export function customerContextTimeout(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return CUSTOMER_CONTEXT_LIMITS.defaultTimeoutMs;
  return Math.min(
    CUSTOMER_CONTEXT_LIMITS.maxTimeoutMs,
    Math.max(CUSTOMER_CONTEXT_LIMITS.minTimeoutMs, Math.round(n)),
  );
}

// Per integration and process: consecutive failures open the circuit for a
// minute, so a dead provider costs one timeout per minute, not one per view.
const FAILURES_TO_OPEN = 5;
const OPEN_MS = 60_000;
const MAX_IN_FLIGHT = 4;
type Circuit = { failures: number; openUntil: number; inFlight: number };
const circuits = new Map<string, Circuit>();
const circuit = (id: string) => {
  let c = circuits.get(id);
  if (!c) circuits.set(id, (c = { failures: 0, openUntil: 0, inFlight: 0 }));
  return c;
};
/** Tests only: forget every circuit. */
export function resetCustomerContextCircuits() {
  circuits.clear();
}

const unavailable = (
  reason: Extract<CustomerContextResult, { status: "unavailable" }>["reason"],
  retryAfterSeconds: number | null = null,
): CustomerContextResult => ({
  status: "unavailable",
  reason,
  retryAfterSeconds,
});

/** A transport failure as an Orbit result; never the provider's text. */
function transportFailure(error: unknown): CustomerContextResult {
  const code = error instanceof ConnectorError ? error.code : "";
  if (code === "REQUEST_TIMEOUT" || code === "DNS_TIMEOUT")
    return unavailable("timeout");
  if (code === "INVALID_ENDPOINT" || code === "PRIVATE_ENDPOINT")
    return unavailable("misconfigured");
  if (code === "RESPONSE_TOO_LARGE") return unavailable("invalid_response");
  if (
    (error as Error)?.name === "AbortError" ||
    (error as Error)?.name === "TimeoutError"
  )
    return unavailable("timeout");
  return unavailable("network");
}

function retryAfter(response: Response) {
  const value = Number(response.headers.get("retry-after"));
  return Number.isInteger(value) && value >= 1 && value <= 3600 ? value : null;
}

/**
 * Reads the customer context of one verified subject. Never throws for a
 * provider problem: every outcome is a result. `fetch` is for tests.
 */
export async function lookupCustomerContext(
  target: CustomerContextTarget,
  subject: CustomerContextSubject,
  options: {
    include?: CustomerContextRequest["include"];
    fetch?: FetchLike;
    now?: () => Date;
  } = {},
): Promise<CustomerContextLookup> {
  const started = Date.now();
  const done = (result: CustomerContextResult) => ({
    result,
    durationMs: Date.now() - started,
  });
  const state = circuit(target.connectionId);
  if (state.openUntil > Date.now())
    return done(
      unavailable(
        "circuit_open",
        Math.max(1, Math.ceil((state.openUntil - Date.now()) / 1000)),
      ),
    );
  if (state.inFlight >= MAX_IN_FLIGHT) return done(unavailable("rate_limited"));
  let url: URL;
  try {
    url = customerContextUrl(target.baseUrl);
  } catch {
    return done(unavailable("misconfigured"));
  }
  const now = (options.now ?? (() => new Date()))();
  const request: CustomerContextRequest = {
    schemaVersion: CUSTOMER_CONTEXT_SCHEMA_VERSION,
    requestId: randomUUID(),
    requestedAt: now.toISOString(),
    integrationId: target.connectionId,
    acceptVersions: [...CUSTOMER_CONTEXT_VERSIONS],
    subject: {
      type: "external_user_id",
      id: subject.id,
      verification: {
        method: "widget_hmac",
        verifiedAt: subject.verifiedAt.toISOString(),
      },
    },
    purpose: "support",
    ...(options.include ? { include: options.include } : {}),
  };
  const body = JSON.stringify(request);
  const timestamp = String(Math.floor(now.valueOf() / 1000));
  state.inFlight += 1;
  let result: CustomerContextResult;
  try {
    const response = await (options.fetch ?? boundedFetch)(url, {
      method: "POST",
      headers: {
        accept: "application/json, application/problem+json",
        "content-type": "application/json",
        authorization: `Bearer ${target.credential.token}`,
        "x-orbit-timestamp": timestamp,
        "x-orbit-request-id": request.requestId,
        "x-orbit-signature": signCustomerContextBody(
          target.credential.signingSecret,
          timestamp,
          body,
        ),
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(customerContextTimeout(target.timeoutMs)),
    });
    const text = await response.text();
    if (Buffer.byteLength(text) > CUSTOMER_CONTEXT_LIMITS.maxBodyBytes)
      result = unavailable("invalid_response");
    else {
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      result = interpretCustomerContextResponse(
        request,
        response.status,
        parsed,
      );
      if (result.status === "unavailable" && result.retryAfterSeconds === null)
        result = { ...result, retryAfterSeconds: retryAfter(response) };
    }
  } catch (error) {
    result = transportFailure(error);
  } finally {
    state.inFlight -= 1;
  }
  // A provider that answers (found, not found, denied) is healthy; repeated
  // failures open the circuit. A rate limit is the provider's own pacing.
  if (result.status !== "unavailable") state.failures = 0;
  else if (
    result.reason !== "rate_limited" &&
    ++state.failures >= FAILURES_TO_OPEN
  ) {
    state.failures = 0;
    state.openUntil = Date.now() + OPEN_MS;
  }
  return done(result);
}
