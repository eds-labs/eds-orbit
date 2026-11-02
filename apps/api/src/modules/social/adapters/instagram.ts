import { SocialError, type ConnectedAccountRef, type PlatformPostRef } from "@opencoredev/social-sdk";
import { instagram } from "@opencoredev/social-sdk/instagram";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { socialFetch } from "../accounts/http.ts";
import { resultFromOutcome, resultFromSocialError } from "./outcome.ts";
import { instagramWorkflowStore } from "./provider-state-store.ts";
import type { SendInput, SendResult, SocialSender } from "./registry.ts";
import { BACKEND, operationContext } from "./x.ts";

// Instagram through the SDK adapter (ADR 0020, S5), Facebook Login flavor
// (the Page's token, the linked professional account). Media go by public
// HTTPS URL (the signed media route, S3). The container flow is kept in
// SocialProviderState, one workflow per publication: once a workflow
// exists, Orbit only continues it, so a retry never creates a second post.
// The daily publishing quota is read before anything is created.

const QUOTA_WAIT_MS = 60 * 60_000;
const READ_ERROR_WAIT_MS = 5 * 60_000;
const READ_BACK_WINDOW_MS = 5 * 60_000;

const workflowIdOf = (publicationId: string) => `pub_${publicationId}`;
const igUserOf = (input: SendInput) => String(input.credentials.config.igUserId ?? input.credentials.externalId);
const accountRef = (input: SendInput) =>
  ({ kind: "connected-account", version: 1, backend: BACKEND, platform: "instagram", accountId: igUserOf(input) }) as ConnectedAccountRef<"instagram">;

function adapterFor(scope: Scope, input: SendInput) {
  return instagram({
    auth: { accessToken: input.credentials.accessToken, accountId: igUserOf(input), flavor: "facebook-login" },
    fetch: socialFetch,
    workflowStore: instagramWorkflowStore(scope, input.publicationId),
  });
}

/** Adds the permalink (best effort) and the workflow id to a result. */
async function finished(adapter: ReturnType<typeof adapterFor>, input: SendInput, result: SendResult): Promise<SendResult> {
  const providerState = { workflowId: workflowIdOf(input.publicationId) };
  if (result.kind === "processing") return { kind: "processing", providerState };
  if (result.kind !== "published") return result;
  let permalink: string | null = null;
  try {
    const ref = {
      kind: "platform-post",
      version: 1,
      backend: BACKEND,
      platform: "instagram",
      accountId: igUserOf(input),
      postId: result.externalPostId,
    } as PlatformPostRef;
    const post = await adapter.posts!.get!(ref, operationContext(input.publicationId));
    permalink = typeof post.permalink === "string" ? post.permalink : null;
  } catch {
    permalink = null;
  }
  return { ...result, permalink, providerState };
}

/** The result of a thrown error, keeping the containers it created. */
function failure(error: unknown, input: SendInput): SendResult {
  const result = resultFromSocialError(error);
  if (result.kind !== "unknown") return result;
  const details = error instanceof SocialError ? (error.details as { createdContainerIds?: unknown } | undefined) : undefined;
  return {
    ...result,
    providerState: {
      workflowId: workflowIdOf(input.publicationId),
      ...(Array.isArray(details?.createdContainerIds) ? { containerIds: details.createdContainerIds } : {}),
    },
  };
}

async function quotaLeft(adapter: ReturnType<typeof adapterFor>, input: SendInput): Promise<SendResult | null> {
  try {
    const limit = await adapter.native!.publishingLimit({ account: accountRef(input), context: operationContext(input.publicationId) });
    const row = (Array.isArray(limit.data) ? limit.data[0] : undefined) as
      | { config?: { quota_total?: unknown }; quota_usage?: unknown }
      | undefined;
    const total = Number(row?.config?.quota_total);
    const used = Number(row?.quota_usage);
    if (Number.isFinite(total) && Number.isFinite(used) && used >= total)
      return { kind: "failed", code: "SOCIAL_RATE_LIMITED", retry: "after-delay", delayMs: QUOTA_WAIT_MS };
    return null;
  } catch (error) {
    const result = resultFromSocialError(error);
    // Reading the quota posts nothing: any other failure only waits.
    return result.kind === "failed" && result.retry === "after-reconnect"
      ? result
      : { kind: "failed", code: "SOCIAL_PROVIDER_UNAVAILABLE", retry: "after-delay", delayMs: READ_ERROR_WAIT_MS };
  }
}

export const instagramSender: SocialSender = {
  async send(scope, input) {
    if (!input.media.length || input.media.some((m) => !m.publicUrl))
      return { kind: "failed", code: "SOCIAL_MEDIA_PUBLIC_REQUIRED", retry: "never" };
    const adapter = adapterFor(scope, input);
    const store = instagramWorkflowStore(scope, input.publicationId);
    try {
      // A workflow of this publication exists: continue it, never start over.
      if (await store.get(workflowIdOf(input.publicationId)))
        return await finished(
          adapter,
          input,
          resultFromOutcome(
            await adapter.native!.resumePublication(accountRef(input), workflowIdOf(input.publicationId), operationContext(input.publicationId)),
          ),
        );
      const quota = await quotaLeft(adapter, input);
      if (quota) return quota;
      const outcome = await adapter.posts!.publishTarget(
        {
          targetIndex: 0,
          targetKey: input.publicationId,
          account: accountRef(input),
          content: {
            text: input.body,
            media: input.media.map((m) => ({
              kind: "image" as const,
              source: { kind: "https-url" as const, url: m.publicUrl! },
              mimeType: "image/jpeg",
              width: m.width,
              height: m.height,
            })),
          },
        },
        operationContext(input.publicationId),
      );
      return await finished(adapter, input, resultFromOutcome(outcome));
    } catch (error) {
      return failure(error, input);
    }
  },
  async reconcile(scope, input) {
    const adapter = adapterFor(scope, input);
    const store = instagramWorkflowStore(scope, input.publicationId);
    try {
      if (await store.get(workflowIdOf(input.publicationId)))
        return await finished(
          adapter,
          input,
          resultFromOutcome(
            await adapter.native!.resumePublication(accountRef(input), workflowIdOf(input.publicationId), operationContext(input.publicationId)),
          ),
        );
      const page = await adapter.posts!.list!(accountRef(input), { limit: 20 }, operationContext(input.publicationId));
      const wanted = input.body.replace(/\s+/g, " ").trim();
      const from = input.since.getTime() - READ_BACK_WINDOW_MS;
      const found = page.items.find(
        (item) =>
          typeof item.caption === "string" &&
          item.caption.replace(/\s+/g, " ").trim() === wanted &&
          typeof item.timestamp === "string" &&
          Date.parse(item.timestamp) >= from,
      );
      if (!found || typeof found.id !== "string") return { kind: "not_found" };
      return {
        kind: "published",
        externalPostId: found.id,
        permalink: typeof found.permalink === "string" ? found.permalink : null,
      };
    } catch (error) {
      return failure(error, input);
    }
  },
};
