import { createHmac } from "node:crypto";
import { z } from "zod";
import { ConnectorError } from "../../../../../../../packages/connectors/src/index.ts";
import { AdsProviderError, type ThrottleHint } from "../types.ts";
import { classifyMetaFailure } from "./errors.ts";
import { metaAdsFetch } from "./transport.ts";
import { parseMetaUsage } from "./usage.ts";
import { META_ADS_GRAPH } from "./version.ts";

export type MetaCredentials = { accessToken: string; appSecret: string };
type Answer<T> = { data: T; usage: ThrottleHint; traceId?: string };

export interface MetaGraphClient {
  get<T>(path: string, params: Record<string, string>, schema: z.ZodType<T>): Promise<Answer<T>>;
  post<T>(path: string, form: Record<string, string>, schema: z.ZodType<T>): Promise<Answer<T>>;
  /** `after` is undefined on the last page; `paging.next` is never requested. */
  page<T>(path: string, params: Record<string, string>, item: z.ZodType<T>, after?: string): Promise<{ items: T[]; after?: string; usage: ThrottleHint }>;
}

const PATH = /^\/[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/;
// `method` can turn a GET into a write, `batch` carries its own URLs, `suppress_http_code` and `callback` change the answer shape.
const RESERVED = ["access_token", "appsecret_proof", "method", "batch", "suppress_http_code", "callback"];
const CREDENTIAL = /^[^\s\p{Cc}]+$/u;

export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(accessToken).digest("hex");
}

function checkInput(path: string, fields: Record<string, string>) {
  if (!PATH.test(path)) throw new Error("Invalid Meta Graph path");
  for (const key of RESERVED) if (key in fields) throw new Error(`Reserved Meta Graph parameter: ${key}`);
}

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return undefined; }
}

export function createMetaGraphClient(credentials: MetaCredentials): MetaGraphClient {
  // An empty value or whitespace/control character would break the header or the proof; nothing has been sent at this point.
  if (!CREDENTIAL.test(credentials.accessToken) || !CREDENTIAL.test(credentials.appSecret)) {
    throw new AdsProviderError({ kind: "auth", code: "ADS_META_TOKEN_INVALID", outcome: "not_sent", retryable: false, fieldPaths: [] });
  }
  const proof = appSecretProof(credentials.accessToken, credentials.appSecret);
  const authorization = `Bearer ${credentials.accessToken}`;

  async function call<T>(method: "GET" | "POST", path: string, fields: Record<string, string>, schema: z.ZodType<T>): Promise<Answer<T>> {
    checkInput(path, fields);
    const write = method === "POST";
    const all = { ...fields, appsecret_proof: proof };
    const search = new URLSearchParams(all).toString();
    const url = `${META_ADS_GRAPH}${path}${write ? "" : `?${search}`}`;
    const init: RequestInit = write
      ? { method, headers: { authorization, "content-type": "application/x-www-form-urlencoded" }, body: search }
      : { method, headers: { authorization } };
    let response: Response;
    try {
      response = await metaAdsFetch(url, init);
    } catch (error) {
      const transport = error instanceof ConnectorError ? error : new ConnectorError("NETWORK_ERROR", write ? "unknown" : "not_sent");
      throw new AdsProviderError(classifyMetaFailure({ write, transport }));
    }
    const body = await readJson(response);
    const traceId = response.headers.get("x-fb-trace-id") ?? undefined;
    const fail = (): never => {
      const failure = classifyMetaFailure({ write, httpStatus: response.status, body, headers: response.headers });
      throw new AdsProviderError({ ...failure, ...(failure.traceId || !traceId ? {} : { traceId: traceId.slice(0, 100) }) });
    };
    if (!response.ok) return fail();
    const parsed = schema.safeParse(body);
    if (!parsed.success) return fail();
    return { data: parsed.data, usage: parseMetaUsage(response.headers), ...(traceId ? { traceId: traceId.slice(0, 100) } : {}) };
  }

  return {
    get: (path, params, schema) => call("GET", path, params, schema),
    post: (path, form, schema) => call("POST", path, form, schema),
    async page(path, params, item, after) {
      const envelopeSchema = envelope(item);
      const result = await call("GET", path, after !== undefined ? { ...params, after } : params, envelopeSchema);
      return { items: result.data.data, after: result.data.paging?.next ? result.data.paging.cursors?.after : undefined, usage: result.usage };
    },
  };
}

function envelope<T>(item: z.ZodType<T>) {
  return z.object({
    data: z.array(item),
    paging: z.object({ cursors: z.object({ after: z.string().optional() }).optional(), next: z.string().optional() })
      // `next` without a usable cursor would end the list silently; treat it as an invalid response.
      .refine(p => p.next === undefined || !!p.cursors?.after, { message: "paging.next requires paging.cursors.after" }).optional(),
  });
}
