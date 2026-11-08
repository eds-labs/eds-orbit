import { boundedFetchWith, type FetchLike } from "../../../../../../../packages/connectors/src/index.ts";

const TIMEOUT_MS = 20_000;
// Insights pages exceed the 2 MB default of boundedFetch.
const bounded = boundedFetchWith({ maxResponseBytes: 8 * 1024 * 1024 });
let transport: FetchLike = bounded;

/** Test hook: replaces the transport; null restores the bounded one. Throws outside tests. */
export function setMetaAdsFetchForTests(next: FetchLike | null): void {
  if (!(process.env.VITEST === "true" || process.env.NODE_ENV === "test")) throw new Error("test only");
  transport = next ?? bounded;
}

/** Every Meta Ads call goes through Orbit's bounded transport; a caller-supplied signal keeps its own deadline. */
export const metaAdsFetch: FetchLike = (input, init = {}) =>
  transport(input, { ...init, signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS) });
