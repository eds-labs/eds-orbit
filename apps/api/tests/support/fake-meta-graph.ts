import { ConnectorError, type FetchLike } from "../../../../packages/connectors/src/index.ts";

export type FakeRequest = { method: string; path: string; query: URLSearchParams; form?: URLSearchParams; authorization: string | null };
export type FakeReply = { status?: number; json?: unknown; headers?: Record<string, string> } | { throw: ConnectorError };
export type FakeHandler = (request: FakeRequest) => FakeReply;

const PREFIX = "/v27.0/";

/** In-memory Graph: a FetchLike that never opens a socket. Unregistered routes and other versions throw. */
export function createFakeMetaGraph() {
  const routes = new Map<string, FakeReply | FakeHandler>();
  const requests: FakeRequest[] = [];
  /** "METHOD url" of every wrong-origin/version or unregistered request; tests assert this stays empty. */
  const misses: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://graph.facebook.com" || !url.pathname.startsWith(PREFIX)) {
      misses.push(`${(init?.method ?? "GET").toUpperCase()} ${url.origin}${url.pathname}`);
      throw new Error(`Fake Meta Graph: request outside ${PREFIX}: ${url.origin}${url.pathname}`);
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.slice(PREFIX.length - 1);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : undefined;
    const request: FakeRequest = { method, path, query: url.searchParams, ...(body !== undefined ? { form: new URLSearchParams(body) } : {}), authorization: headers.get("authorization") };
    requests.push(request);
    const route = routes.get(`${method} ${path}`);
    if (!route) {
      misses.push(`${method} ${url.origin}${url.pathname}`);
      throw new Error(`Fake Meta Graph: no route for ${method} ${path}`);
    }
    const reply = typeof route === "function" ? route(request) : route;
    if ("throw" in reply) throw reply.throw;
    return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200, headers: { "content-type": "application/json", ...reply.headers } });
  };
  return {
    fetch,
    requests,
    misses,
    on(method: "GET" | "POST", path: string, reply: FakeReply | FakeHandler) { routes.set(`${method} ${path}`, reply); },
  };
}

export function graphError(status: number, code: number, extra: { subcode?: number; transient?: boolean; userTitle?: string; userMessage?: string; blame?: string[][] } = {}): FakeReply {
  return {
    status,
    json: {
      error: {
        message: "Graph error", type: "OAuthException", code,
        ...(extra.subcode !== undefined ? { error_subcode: extra.subcode } : {}),
        ...(extra.transient ? { is_transient: true } : {}),
        ...(extra.userTitle ? { error_user_title: extra.userTitle } : {}),
        ...(extra.userMessage ? { error_user_msg: extra.userMessage } : {}),
        ...(extra.blame ? { error_data: { blame_field_specs: extra.blame } } : {}),
        fbtrace_id: "FAKETRACE",
      },
    },
  };
}

export function usageHeaders(input: { type?: string; callCount?: number; regainMinutes?: number; tier?: string } = {}): Record<string, string> {
  return {
    "x-business-use-case-usage": JSON.stringify({
      "1": [{ type: input.type ?? "ads_management", call_count: input.callCount ?? 1, total_cputime: 0, total_time: 0, estimated_time_to_regain_access: input.regainMinutes ?? 0, ...(input.tier ? { ads_api_access_tier: input.tier } : {}) }],
    }),
  };
}

/** Answers with each reply in turn; the last one repeats. */
export function sequence(...replies: FakeReply[]): FakeHandler {
  let index = 0;
  return () => replies[Math.min(index++, replies.length - 1)]!;
}

/** Runs `apply` (the write took effect), then answers: e.g. with 500, the answer was lost. */
export function afterCommit(apply: () => void, reply: FakeReply): FakeHandler {
  return () => { apply(); return reply; };
}
