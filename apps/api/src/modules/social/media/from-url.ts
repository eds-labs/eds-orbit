import {
  boundedFetchWith,
  ConnectorError,
  type FetchLike,
} from "../../../../../../packages/connectors/src/http.ts";
import { maxFileBytes } from "../../../platform/files/files.ts";
import { DomainError } from "../../../shared.ts";

// Images by HTTPS URL into the Social media library (MCP import, and the
// download URL a client such as ChatGPT hands over for a file it created).
// The connectors' SSRF-safe transport resolves the host once, refuses every
// non-public address and pins the checked address for the request; every
// redirect target is checked the same way, at most three times. The body is
// capped at the file limit, and the library sniffs the bytes afterwards:
// the declared type is never trusted.

const MAX_REDIRECTS = 3;
const MAX_URL_LENGTH = 4000;
const TIMEOUT_MS = 20_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

let fetcher: FetchLike | null = null;
/** Tests replace the transport; null restores the SSRF-safe one. */
export function setMediaUrlFetchForTests(replacement: FetchLike | null) {
  fetcher = replacement;
}

/** The URL if it may be fetched at all: HTTPS on 443, no credentials, no fragment. */
export function checkedMediaUrl(input: string): URL {
  if (input.length > MAX_URL_LENGTH) throw new DomainError("SOCIAL_MEDIA_URL_NOT_ALLOWED", 422);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new DomainError("SOCIAL_MEDIA_URL_INVALID", 422);
  }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password)
    throw new DomainError("SOCIAL_MEDIA_URL_NOT_ALLOWED", 422);
  url.hash = "";
  return url;
}

/** The last path segment, as a file name suggestion (the library cleans it). */
function nameOf(url: URL): string | undefined {
  const segment = url.pathname.split("/").filter(Boolean).pop();
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment).slice(0, 200);
  } catch {
    return undefined;
  }
}

function translate(error: unknown): never {
  if (error instanceof DomainError) throw error;
  if (error instanceof ConnectorError) {
    if (error.code === "PRIVATE_ENDPOINT" || error.code === "INVALID_ENDPOINT")
      throw new DomainError("SOCIAL_MEDIA_URL_NOT_ALLOWED", 422);
    if (error.code === "RESPONSE_TOO_LARGE") throw new DomainError("SOCIAL_MEDIA_TOO_LARGE", 413);
  }
  throw new DomainError("SOCIAL_MEDIA_URL_UNREACHABLE", 502);
}

/** The bytes behind an HTTPS URL, with the server's type and a name suggestion. */
export async function fetchMediaUrl(input: string): Promise<{ bytes: Buffer; mime: string; name?: string }> {
  const limit = maxFileBytes();
  const transport = fetcher ?? boundedFetchWith({ maxResponseBytes: limit });
  let url = checkedMediaUrl(input);
  for (let hop = 0; ; hop += 1) {
    let response: Response;
    try {
      response = await transport(url, {
        method: "GET",
        headers: { accept: "image/png, image/jpeg, image/webp" },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      translate(error);
    }
    if (REDIRECTS.has(response.status)) {
      const location = response.headers.get("location");
      if (!location || hop >= MAX_REDIRECTS) throw new DomainError("SOCIAL_MEDIA_URL_REDIRECTS", 422);
      url = checkedMediaUrl(new URL(location, url).toString());
      continue;
    }
    if (response.status !== 200) throw new DomainError("SOCIAL_MEDIA_URL_UNREACHABLE", 502);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) throw new DomainError("SOCIAL_MEDIA_TOO_LARGE", 413);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new DomainError("SOCIAL_MEDIA_INVALID", 422);
    if (bytes.length > limit) throw new DomainError("SOCIAL_MEDIA_TOO_LARGE", 413);
    const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    return { bytes, mime, name: nameOf(url) };
  }
}
