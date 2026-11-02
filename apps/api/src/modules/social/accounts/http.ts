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
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  return transport(url, { ...options, signal });
};
