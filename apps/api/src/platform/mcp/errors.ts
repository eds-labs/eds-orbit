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
import { DomainError } from "../shared.ts";

/** Tool-result `_meta` key that carries a WWW-Authenticate challenge (ChatGPT links from it). */
export const WWW_AUTHENTICATE_META = "mcp/www_authenticate";

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
 */
export function toolFailure(
  error: unknown,
  requestId: string,
): { result: CallToolResult; code: string } {
  if (error instanceof DomainError || error instanceof KnowledgeError) {
    const status = error instanceof DomainError ? error.status : 409;
    return {
      result: codeResult(error.code, status === 429 || status >= 500),
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

/** 401 with the PRM challenge, shaped like requireMcpAuth's own refusal. */
export const unauthenticatedResponse = (resource: string) =>
  rpcErrorResponse(401, "the grant is not active", {
    "www-authenticate": bearerChallenge(resource),
  });
