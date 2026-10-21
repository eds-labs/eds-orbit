import { z } from "zod";
import {
  CUSTOMER_CONTEXT_LIMITS,
  CUSTOMER_CONTEXT_PATH,
  CUSTOMER_CONTEXT_PROBLEMS,
  customerContext,
  customerContextProblem,
  customerContextRequest,
} from "./customer-context.ts";

/**
 * Builds the published v1 artifacts from the zod source (ADR 0011): three
 * JSON Schemas (draft 2020-12) and the provider OpenAPI 3.1 document with
 * the reviewed examples embedded. Deterministic, so a contract test can
 * compare the committed files with a fresh build.
 */

export const CUSTOMER_CONTEXT_CONTRACT_DIR =
  "packages/schemas/contracts/customer-context/v1";
const ID_BASE = "urn:eds-orbit:contract:customer-context:v1:";

type Json = Record<string, unknown>;
export type CustomerContextExamples = Record<string, Json>;

function jsonSchema(
  schema: z.ZodType,
  name: string,
  standalone: boolean,
): Json {
  const out = z.toJSONSchema(schema, { target: "draft-2020-12" }) as Json;
  if (!standalone) {
    delete out.$schema;
    return out;
  }
  return { $schema: out.$schema, $id: `${ID_BASE}${name}`, ...out };
}

/** Which committed example illustrates which response of the lookup. */
export const OPENAPI_EXAMPLES = {
  request: ["request"],
  200: [
    "found-active",
    "found-credits-exhausted",
    "found-feature-denied",
    "found-unlimited-and-unknown",
    "found-canceled-at-period-end",
    "found-no-subscription",
  ],
  400: ["problem-unsupported-version"],
  401: ["problem-unauthenticated"],
  403: ["problem-access-denied"],
  404: ["problem-not-found"],
  422: ["problem-identity-not-verified"],
  429: ["problem-rate-limited"],
  503: ["problem-service-unavailable"],
  504: ["problem-upstream-timeout"],
} as const;

const responseText: Record<string, string> = {
  400: "Invalid request or unsupported schema version (`invalid_request`, `unsupported_version`).",
  401: "Missing or wrong bearer token or signature (`unauthenticated`).",
  403: "The integration may not read this customer (`access_denied`).",
  404: "No customer with this external user id (`customer_not_found`).",
  422: "The product does not accept this identity as verified (`identity_not_verified`).",
  429: "Rate limit of the provider (`rate_limited`).",
  503: "The product or its data is temporarily unavailable (`service_unavailable`).",
  504: "The gateway's call to the product timed out (`upstream_timeout`).",
};

function examplesOf(
  names: readonly string[],
  examples: CustomerContextExamples,
) {
  return Object.fromEntries(
    names.map((name) => {
      const value = examples[name];
      if (!value) throw new Error(`missing example ${name}`);
      return [name, { value }];
    }),
  );
}

export function buildCustomerContextContract(
  examples: CustomerContextExamples,
) {
  const problemRef = { $ref: "#/components/schemas/CustomerContextProblem" };
  const responses: Json = {
    200: {
      description:
        "The customer's context. Unknown values are null; a null amount is never 0.",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/CustomerContext" },
          examples: examplesOf(OPENAPI_EXAMPLES[200], examples),
        },
      },
    },
  };
  for (const status of [400, 401, 403, 404, 422, 429, 503, 504] as const) {
    responses[status] = {
      description: responseText[status],
      ...(status === 429 || status === 503
        ? {
            headers: {
              "Retry-After": { schema: { type: "integer", minimum: 1 } },
            },
          }
        : {}),
      content: {
        "application/problem+json": {
          schema: problemRef,
          examples: examplesOf(OPENAPI_EXAMPLES[status], examples),
        },
      },
    };
  }
  const signedHeader = (name: string, description: string, schema: Json) => ({
    name,
    in: "header",
    required: true,
    description,
    schema,
  });
  const openapi = {
    openapi: "3.1.0",
    info: {
      title: "Orbit Customer Context Provider",
      version: "1.0.0",
      summary: "Read-only, product-neutral customer context for Orbit Support.",
      description: [
        "Implemented by a product (or by n8n in front of it) and called by Orbit for `customer_context.read`.",
        "See ADR 0011 and docs/CUSTOMER_CONTEXT.md. Orbit sends only verified identities.",
        `Bodies are at most ${CUSTOMER_CONTEXT_LIMITS.maxBodyBytes} bytes; Orbit waits at most ${CUSTOMER_CONTEXT_LIMITS.maxTimeoutMs} ms.`,
        'Signature: `X-Orbit-Signature: v1=<hex HMAC-SHA256(signingSecret, X-Orbit-Timestamp + "." + rawBody)>`.',
        `Reject timestamps more than ${CUSTOMER_CONTEXT_LIMITS.signatureToleranceSeconds} s off and compare in constant time.`,
      ].join("\n\n"),
    },
    servers: [
      {
        url: "{baseUrl}",
        description: "The integration's HTTPS base URL configured in Orbit.",
        variables: {
          baseUrl: { default: "https://provider.example.com/orbit" },
        },
      },
    ],
    security: [{ integrationToken: [] }],
    paths: {
      [CUSTOMER_CONTEXT_PATH]: {
        post: {
          operationId: "lookupCustomerContext",
          summary:
            "Read the context of one verified customer (customer_context.read).",
          parameters: [
            signedHeader(
              "X-Orbit-Timestamp",
              "Unix time in seconds when Orbit signed the request.",
              {
                type: "string",
                pattern: "^[0-9]{10}$",
              },
            ),
            signedHeader(
              "X-Orbit-Signature",
              "HMAC-SHA256 over timestamp, a dot and the raw body.",
              {
                type: "string",
                pattern: "^v1=[0-9a-f]{64}$",
              },
            ),
            signedHeader(
              "X-Orbit-Request-Id",
              "Equals `requestId` in the body.",
              {
                type: "string",
                format: "uuid",
              },
            ),
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CustomerContextRequest" },
                examples: examplesOf(OPENAPI_EXAMPLES.request, examples),
              },
            },
          },
          responses,
        },
      },
    },
    components: {
      securitySchemes: {
        integrationToken: {
          type: "http",
          scheme: "bearer",
          description:
            "Per-integration token issued for Orbit. Required together with the signature.",
        },
      },
      schemas: {
        CustomerContextRequest: jsonSchema(
          customerContextRequest,
          "request",
          false,
        ),
        CustomerContext: jsonSchema(customerContext, "customer-context", false),
        CustomerContextProblem: jsonSchema(
          customerContextProblem,
          "problem",
          false,
        ),
      },
    },
    "x-orbit-problem-codes": CUSTOMER_CONTEXT_PROBLEMS,
  };
  return {
    "openapi.json": openapi,
    "customer-context-request.schema.json": jsonSchema(
      customerContextRequest,
      "customer-context-request",
      true,
    ),
    "customer-context.schema.json": jsonSchema(
      customerContext,
      "customer-context",
      true,
    ),
    "problem.schema.json": jsonSchema(customerContextProblem, "problem", true),
  } as Record<string, Json>;
}

/** Stable file text: two-space JSON with a trailing newline. */
export const contractText = (value: unknown) =>
  `${JSON.stringify(value, null, 2)}\n`;
