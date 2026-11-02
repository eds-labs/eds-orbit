import { createHash } from "node:crypto";
import type { AdapterOperationContext, ConnectedAccountRef } from "@opencoredev/social-sdk";
import { x } from "@opencoredev/social-sdk/x";
import { socialFetch } from "../accounts/http.ts";
import { resultFromOutcome, resultFromSocialError } from "./outcome.ts";
import type { SendInput, SocialSender } from "./registry.ts";

// X through the SDK adapter (ADR 0020, S5). The adapter's own publish path
// skips the 280-character check, so X Premium accounts post long texts
// (validated by Orbit, S4). The token is fixed when the adapter is built,
// so every send builds one with the account's current credentials. X
// refuses alt text in SDK 0.5.0; images go up as Blobs of at most 5 MiB.

export const BACKEND = "orbit";
const READ_BACK_WINDOW_MS = 5 * 60_000;

export const operationContext = (correlationId: string): AdapterOperationContext => ({
  correlationId,
  backendInstance: BACKEND,
  retryBudget: { maxAttempts: 1, maxElapsedMs: 120_000 },
});

const adapterFor = (input: SendInput) =>
  x({ auth: { userId: input.credentials.externalId, accessToken: input.credentials.accessToken }, fetch: socialFetch });
const accountRef = (input: SendInput) =>
  ({ kind: "connected-account", version: 1, backend: BACKEND, platform: "x", accountId: input.credentials.externalId }) as ConnectedAccountRef<"x">;
const permalink = (handle: string, id: string) => `https://x.com/${handle.replace(/^@/, "")}/status/${id}`;
/** X shortens links and may collapse spaces: compare texts without both. */
const normalized = (text: string) => text.replace(/https?:\/\/\S+/g, "<url>").replace(/\s+/g, " ").trim();

export const xSender: SocialSender = {
  async send(_scope, input) {
    const adapter = adapterFor(input);
    const media = input.media.map((m) => ({
      kind: "image" as const,
      source: {
        kind: "blob" as const,
        blob: new Blob([new Uint8Array(m.bytes)], { type: m.mime }),
        fingerprint: createHash("sha256").update(m.bytes).digest("hex"),
      },
      mimeType: m.mime,
    }));
    const replySettings = input.options.replySettings;
    try {
      const outcome = await adapter.posts!.publishTarget(
        {
          targetIndex: 0,
          targetKey: input.publicationId,
          account: accountRef(input),
          content: { text: input.body, ...(media.length ? { media } : {}) },
          ...(replySettings ? { options: { replySettings } } : {}),
        },
        operationContext(input.publicationId),
      );
      const result = resultFromOutcome(outcome);
      return result.kind === "published" ? { ...result, permalink: permalink(input.account.handle, result.externalPostId) } : result;
    } catch (error) {
      return resultFromSocialError(error);
    }
  },
  async reconcile(_scope, input) {
    const adapter = adapterFor(input);
    try {
      const page = await adapter.posts!.list!(accountRef(input), { limit: 20 }, operationContext(input.publicationId));
      const wanted = normalized(input.body);
      const from = input.since.getTime() - READ_BACK_WINDOW_MS;
      const found = page.items.find(
        (item) =>
          typeof item.text === "string" &&
          normalized(item.text) === wanted &&
          typeof item.created_at === "string" &&
          Date.parse(item.created_at) >= from,
      );
      if (!found || typeof found.id !== "string") return { kind: "not_found" };
      return { kind: "published", externalPostId: found.id, permalink: permalink(input.account.handle, found.id) };
    } catch (error) {
      return resultFromSocialError(error);
    }
  },
};
