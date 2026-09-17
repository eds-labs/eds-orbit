import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as schemas from "../../../packages/schemas/src/index.ts";
const entity = {
  type: "object",
  required: ["id", "kind", "version", "data"],
  properties: {
    id: { type: "string", format: "uuid" },
    workspaceId: { type: "string", format: "uuid" },
    projectId: { type: "string", format: "uuid" },
    kind: { type: "string" },
    version: { type: "integer", minimum: 1 },
    data: { type: "object", additionalProperties: true },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
};
export function installOpenApiSchemas(app: FastifyInstance) {
  app.addHook("onRoute", (route) => {
    if (!route.url.startsWith("/api/")) return;
    if (route.url.startsWith("/api/auth/")) {
      route.schema = { ...route.schema, hide: true };
      return;
    }
    const names = [...route.url.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!);
    const params = names.length
      ? {
          type: "object",
          required: names,
          properties: Object.fromEntries(
            names.map((n) => [
              n,
              {
                type: "string",
                ...(n === "projectId" || n === "id" ? { format: "uuid" } : {}),
              },
            ]),
          ),
        }
      : undefined;
    const error = {
      type: "object",
      properties: {
        error: {
          type: "object",
          properties: { code: { type: "string" }, message: { type: "string" } },
          required: ["code", "message"],
        },
      },
      required: ["error"],
    };
    const method = Array.isArray(route.method) ? route.method[0] : route.method;
    let response: any = { type: "object", additionalProperties: true };
    if (route.url.endsWith("/:collection") && method === "GET")
      response = {
        type: "object",
        required: ["items"],
        properties: { items: { type: "array", items: entity } },
      };
    route.schema = {
      ...route.schema,
      operationId: method + "_" + route.url.replace(/[^a-z0-9]/gi, "_"),
      summary: route.url,
      ...(params ? { params: params as any } : {}),
      response: {
        200: response,
        201: response,
        400: error,
        401: error,
        403: error,
        404: error,
        409: error,
        429: error,
      },
    };
    // Fastify response serializers keep generic entity data as validated JSON instead of exposing ORM internals.
  });
}
export const contractSchemas = {
  source: z.toJSONSchema(schemas.source),
  mission: z.toJSONSchema(schemas.mission),
  content: z.toJSONSchema(schemas.content),
  policy: z.toJSONSchema(schemas.policy),
  metric: z.toJSONSchema(schemas.metric),
};
