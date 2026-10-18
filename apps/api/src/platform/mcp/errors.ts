/**
 * How the MCP gateway answers failures (Track M, WP-M2,
 * plans/orbit-modularization/09 §6.4). Every text here is fixed or built from
 * error codes and schema paths: the SDK sends a thrown error's message to the
 * client, so tool handlers return these results instead of throwing, and no
 * argument value, result or internal message ever reaches the client.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import { createResourceServerChallenge } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import { ZodError } from "zod";
import { KnowledgeError } from "../../../../../packages/knowledge/src/index.ts";
import type { ToolRisk } from "../../modules/agents/tools/registry.ts";
import { DomainError } from "../shared.ts";

/** Tool-result `_meta` key that carries a WWW-Authenticate challenge (ChatGPT links from it). */
export const WWW_AUTHENTICATE_META = "mcp/www_authenticate";

/** Thrown by the adapter when a tool call outlives its time limit (D-M3-11). */
export class McpToolTimeoutError extends Error {
  constructor() {
    super("MCP_TOOL_TIMEOUT");
    this.name = "McpToolTimeoutError";
  }
}

/**
 * Thrown by the adapter when a grant has used up its proposal quota (WP-M4,
 * D-M4-8). Carries nothing: the answer is fixed text.
 */
export class McpProposalQuotaError extends Error {
  constructor() {
    super("PROPOSAL_QUOTA_EXCEEDED");
    this.name = "McpProposalQuotaError";
  }
}

/** The code and fixed text of a refused proposal (quota used up). */
export const PROPOSAL_QUOTA_CODE = "PROPOSAL_QUOTA_EXCEEDED";
export const proposalQuotaResult = () =>
  errorResult({
    code: PROPOSAL_QUOTA_CODE,
    message: "the proposal quota of this connection is used up for now",
    retryable: false,
  });

/**
 * Whether a client may retry a call that failed in a transient way (timeout,
 * 429, 5xx). Never for proposals and internal writes (WP-M4, D-M4-11): the
 * work may have completed, and a retry could create it twice.
 */
export const transientRetryable = (risk: ToolRisk) =>
  risk !== "P_proposal" && risk !== "W0_internal";

/**
 * The fixed answer to a call that outlived its limit; the work may still
 * finish. `risk` is required: a missing risk must never read as retryable.
 */
export const timeoutResult = (risk: ToolRisk) =>
  errorResult({
    code: "TIMEOUT",
    message: "the tool did not finish in time; its work may still complete",
    retryable: transientRetryable(risk),
  });

/** `structuredContent` of every gateway error result. */
export type McpErrorBody = {
  code: string;
  message: string;
  retryable: boolean;
};

/** The REST API's message for a code (server.ts): the code in words. */
const messageFor = (code: string) => code.replaceAll("_", " ").slice(0, 200);

/** An isError tool result; `content` is the JSON copy of the body. */
export function errorResult(
  body: McpErrorBody,
  meta?: Record<string, unknown>,
): CallToolResult {
  return {
    isError: true,
    structuredContent: body,
    content: [{ type: "text", text: JSON.stringify(body) }],
    ...(meta ? { _meta: meta } : {}),
  };
}

/** An error result for a code, with the REST message and no retry hint. */
export const codeResult = (code: string, retryable = false) =>
  errorResult({ code, message: messageFor(code), retryable });

/** Path segments safe to name: schema keys and indexes, never free text. */
function safePaths(error: ZodError): string[] {
  const paths = error.issues.map((issue) =>
    issue.path
      .map(String)
      .filter((part) => /^[A-Za-z0-9_]{1,64}$/.test(part))
      .slice(0, 4)
      .join("."),
  );
  return [...new Set(paths.filter(Boolean))].slice(0, 8);
}

/**
 * A failure inside a tool call as an isError result, plus the code to log
 * and audit. DomainError and KnowledgeError keep their code (AD-14, the REST
 * codes); a ZodError (the tool's own validation) names paths only; anything
 * else is REQUEST_FAILED with the request id, its message never sent.
 * `risk` is the tool's (required): transient failures are retryable only for
 * reads.
 */
export function toolFailure(
  error: unknown,
  requestId: string,
  risk: ToolRisk,
): { result: CallToolResult; code: string } {
  if (error instanceof McpToolTimeoutError)
    return { result: timeoutResult(risk), code: "TIMEOUT" };
  if (error instanceof McpProposalQuotaError)
    return { result: proposalQuotaResult(), code: PROPOSAL_QUOTA_CODE };
  if (error instanceof DomainError || error instanceof KnowledgeError) {
    const status = error instanceof DomainError ? error.status : 409;
    return {
      result: codeResult(
        error.code,
        (status === 429 || status >= 500) && transientRetryable(risk),
      ),
      code: error.code,
    };
  }
  if (error instanceof ZodError) {
    const paths = safePaths(error);
    const code = "VALIDATION_FAILED";
    return {
      result: errorResult({
        code,
        message: `${messageFor(code)}${paths.length ? `: ${paths.join(", ")}` : ""}`,
        retryable: false,
      }),
      code,
    };
  }
  return { result: internalFailure(requestId), code: "REQUEST_FAILED" };
}

/** REQUEST_FAILED with the request id, for errors whose detail stays in the logs. */
export const internalFailure = (requestId: string) =>
  errorResult({
    code: "REQUEST_FAILED",
    message: `request failed (request id ${requestId})`,
    retryable: false,
  });

/**
 * The RFC 6750 / RFC 9728 challenge for a request without a usable grant,
 * as Better Auth builds it for an invalid token (same `resource_metadata`).
 */
export function bearerChallenge(resource: string): string {
  const challenge = createResourceServerChallenge(
    new APIError("UNAUTHORIZED", { message: "the grant is not active" }),
    resource,
  );
  const header = challenge
    ? new Headers(challenge.headers).get("WWW-Authenticate")
    : null;
  if (!header) throw new Error("MCP_CHALLENGE_UNAVAILABLE");
  return header;
}

/** A tool call whose token verifies but whose grant is gone (revoked, expired, left). */
export const unauthenticatedResult = (resource: string) =>
  errorResult(
    { code: "UNAUTHENTICATED", message: "UNAUTHENTICATED", retryable: false },
    { [WWW_AUTHENTICATE_META]: [bearerChallenge(resource)] },
  );

/** A JSON-RPC error response without request id (transport-level refusals). */
export function rpcErrorResponse(
  status: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
    { status, headers: { "content-type": "application/json", ...headers } },
  );
}

/** The JSON-RPC answer to a method the gateway does not serve (-32601), as a 200 response. */
export const methodNotFoundResponse = (id: string | number | null) =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found" },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/** 400 for a JSON-RPC batch (an array body): the gateway serves single messages only. */
export const batchRefusedResponse = () =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Batch requests are not supported" },
      id: null,
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );

/** 429 with the wait in `Retry-After` (seconds). */
export const rateLimitedResponse = (retryAfterSeconds: number) =>
  rpcErrorResponse(429, "Rate limit exceeded", {
    "retry-after": String(retryAfterSeconds),
  });

/** 401 with the PRM challenge, shaped like requireMcpAuth's own refusal. */
export const unauthenticatedResponse = (resource: string) =>
  rpcErrorResponse(401, "the grant is not active", {
    "www-authenticate": bearerChallenge(resource),
  });
