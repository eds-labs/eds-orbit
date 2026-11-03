import { ConnectorError } from "../../../../../../packages/connectors/src/index.ts";
import { socialFetch } from "../accounts/http.ts";
import { META_GRAPH } from "../accounts/meta.ts";
import type { SendInput, SendResult, SocialSender } from "./registry.ts";

// Facebook Pages (ADR 0020, S5b) through Orbit's own Graph calls: no SDK
// version ships a Facebook adapter. Images go up unpublished (invisible;
// Meta deletes them after about a day), then exactly one /feed call creates
// the visible post. Only that call can publish, so only its unclear answers
// are "unknown"; a failed upload leaves nothing visible and may be retried.
// The Page token comes from the Meta connection (S2), the Graph version
// from accounts/meta.ts.

type Step = "upload" | "publish" | "read";
type GraphError = { code?: number; error_subcode?: number; is_transient?: boolean };

const THROTTLE_WAIT_MS = 60_000;
const BLOCK_WAIT_MS = 60 * 60_000;
const OUTAGE_WAIT_MS = 5 * 60_000;
const UPLOAD_TIMEOUT_MS = 60_000;
const PUBLISH_TIMEOUT_MS = 30_000;
const READ_BACK_WINDOW_MS = 5 * 60_000;
// Throttles of the app, the user, the Page and the business use cases.
const RATE_LIMIT_CODES = new Set([4, 17, 32, 341, 613, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80014]);
// "Temporarily blocked for policies violations": Meta asks to wait.
const TEMPORARY_BLOCK = 368;

/** A Graph answer that ends the attempt, already as a send result. */
class GraphFailure extends Error {
  constructor(readonly result: SendResult) {
    super(result.kind);
  }
}

const waitAfterOutage = (): SendResult => ({ kind: "failed", code: "SOCIAL_PROVIDER_UNAVAILABLE", retry: "after-delay", delayMs: OUTAGE_WAIT_MS });

/** What a Graph error means for this step: only the publishing step can leave a post behind. */
function graphFailure(status: number, error: GraphError, step: Step): SendResult {
  const code = error.code;
  if (code === 190 || code === 102 || (status === 401 && code === undefined))
    return { kind: "failed", code: "SOCIAL_META_TOKEN_INVALID", retry: "after-reconnect" };
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299))
    return { kind: "failed", code: "SOCIAL_META_PERMISSION_MISSING", retry: "after-reconnect" };
  if ((code !== undefined && RATE_LIMIT_CODES.has(code)) || status === 429)
    return { kind: "failed", code: "SOCIAL_RATE_LIMITED", retry: "after-delay", delayMs: THROTTLE_WAIT_MS };
  if (code === TEMPORARY_BLOCK) return { kind: "failed", code: "SOCIAL_RATE_LIMITED", retry: "after-delay", delayMs: BLOCK_WAIT_MS };
  if (status >= 500 || code === 1 || code === 2 || error.is_transient === true)
    return step === "publish" ? { kind: "unknown", code: "SOCIAL_PROVIDER_UNAVAILABLE" } : waitAfterOutage();
  return { kind: "failed", code: "SOCIAL_PROVIDER_REJECTED", retry: "never" };
}

/** A transport error: a request that never left only waits; one that may have arrived is unknown when it could publish. */
function transportFailure(error: unknown, step: Step): SendResult {
  const notSent = error instanceof ConnectorError && error.outcome === "not_sent";
  return step === "publish" && !notSent ? { kind: "unknown", code: "SOCIAL_PROVIDER_UNKNOWN" } : waitAfterOutage();
}

const pageOf = (input: SendInput) => input.credentials.pageId ?? String(input.credentials.config.pageId ?? input.credentials.externalId);

async function graph(input: SendInput, path: string, init: RequestInit, step: Step): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await socialFetch(`${META_GRAPH}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${input.credentials.accessToken}` },
    });
  } catch (error) {
    throw new GraphFailure(transportFailure(error, step));
  }
  const body = (await response.json().catch(() => null)) as { error?: GraphError } | null;
  if (!response.ok || body?.error) throw new GraphFailure(graphFailure(response.status, body?.error ?? {}, step));
  return (body ?? {}) as Record<string, unknown>;
}

const postUrl = (id: string, permalink: unknown) =>
  typeof permalink === "string" && permalink.startsWith("https://www.facebook.com/") ? permalink : `https://www.facebook.com/${id}`;
/** Facebook may collapse spaces: compare texts without them. */
const normalized = (text: string) => text.replace(/\s+/g, " ").trim();
/** Graph writes offsets as "+0000". */
const timeOf = (value: unknown) => (typeof value === "string" ? Date.parse(value.replace(/([+-]\d\d)(\d\d)$/, "$1:$2")) : Number.NaN);

export const facebookSender: SocialSender = {
  async send(_scope, input) {
    const page = encodeURIComponent(pageOf(input));
    let step: Step = "upload";
    try {
      const photos: string[] = [];
      for (const m of input.media) {
        const form = new FormData();
        form.set("source", new Blob([new Uint8Array(m.bytes)], { type: m.mime }), `${m.fileId}.${m.mime === "image/png" ? "png" : "jpg"}`);
        form.set("published", "false");
        const uploaded = await graph(input, `/${page}/photos`, { method: "POST", body: form, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) }, "upload");
        if (typeof uploaded.id !== "string" || !uploaded.id) return waitAfterOutage();
        photos.push(uploaded.id);
      }
      step = "publish";
      const posted = await graph(
        input,
        `/${page}/feed?fields=id,permalink_url`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(input.body ? { message: input.body } : {}),
            ...(photos.length ? { attached_media: photos.map((id) => ({ media_fbid: id })) } : {}),
            published: true,
          }),
          signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
        },
        "publish",
      );
      if (typeof posted.id !== "string" || !posted.id) return { kind: "unknown", code: "SOCIAL_PROVIDER_UNKNOWN" };
      return { kind: "published", externalPostId: posted.id, permalink: postUrl(posted.id, posted.permalink_url) };
    } catch (error) {
      if (error instanceof GraphFailure) return error.result;
      return step === "publish" ? { kind: "unknown", code: "SOCIAL_PROVIDER_UNKNOWN" } : waitAfterOutage();
    }
  },

  async reconcile(_scope, input) {
    // A post without text cannot be told apart: the owner settles it.
    const wanted = normalized(input.body);
    if (!wanted) return { kind: "not_found" };
    try {
      const page = encodeURIComponent(pageOf(input));
      const listed = await graph(input, `/${page}/posts?fields=id,message,created_time,permalink_url&limit=20`, { method: "GET" }, "read");
      const from = input.since.getTime() - READ_BACK_WINDOW_MS;
      const items = Array.isArray(listed.data) ? (listed.data as Array<Record<string, unknown>>) : [];
      const found = items.find(
        (item) => typeof item.message === "string" && normalized(item.message) === wanted && timeOf(item.created_time) >= from,
      );
      if (!found || typeof found.id !== "string") return { kind: "not_found" };
      return { kind: "published", externalPostId: found.id, permalink: postUrl(found.id, found.permalink_url) };
    } catch (error) {
      return error instanceof GraphFailure ? error.result : waitAfterOutage();
    }
  },
};
