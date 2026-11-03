import { boundedFetch, type FetchLike } from "../../../../../../packages/connectors/src/index.ts";

// Every provider call of the social module goes through Orbit's bounded
// transport (https only, public addresses, capped bodies, no redirects).
// The SDK takes this as its `fetch`, so it may hand over a Request.

const TIMEOUT_MS = 20_000;
let transport: FetchLike = boundedFetch;

/** Test hook: replaces the transport; null restores the bounded one. */
export function setSocialFetchForTests(next: FetchLike | null) {
  transport = next ?? boundedFetch;
}

export const socialFetch: typeof fetch = async (input, init = {}) => {
  let url: string;
  let options: RequestInit = init;
  if (input instanceof Request) {
    url = input.url;
    const body = input.method === "GET" || input.method === "HEAD" ? undefined : await input.arrayBuffer();
    options = { method: input.method, headers: input.headers, ...(body ? { body } : {}), ...init };
  } else url = String(input);
  // A caller with its own deadline keeps it (Telegram media uploads allow
  // 60 s, the SDK its own budget); otherwise 20 s apply.
  const signal = options.signal ?? AbortSignal.timeout(TIMEOUT_MS);
  return transport(url, { ...options, signal });
};

/**
 * A socialFetch that remembers the last HTTP status. The SDK reports a 401
 * at a token endpoint (a refused client: the developer app) like a refused
 * grant, without the status, so callers read it here.
 */
export function statusRecordingFetch() {
  let last: number | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const response = await socialFetch(input, init);
    last = response.status;
    return response;
  };
  return { fetch, lastStatus: () => last };
}
