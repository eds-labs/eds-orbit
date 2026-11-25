import { ConnectorError } from "../../../../../../packages/connectors/src/index.ts";
import { LINKEDIN_REST, linkedinHeaders } from "../accounts/channel-oauth.ts";
import { socialFetch } from "../accounts/http.ts";
import type { SendInput, SendResult, SocialSender } from "./registry.ts";

const temporary = (image?: string): SendResult => ({
  kind: "failed",
  code: "SOCIAL_PROVIDER_UNAVAILABLE",
  retry: "after-delay",
  delayMs: 60_000,
  ...(image ? { providerState: { linkedinImage: image } } : {}),
});
const unknown = (): SendResult => ({
  kind: "unknown",
  code: "SOCIAL_PROVIDER_UNKNOWN",
});
const imageUrn = /^urn:li:image:[\w-]+$/;
const postUrn = /^urn:li:(?:share|ugcPost):\d+$/;

function refused(response: Response, mayPublish: boolean): SendResult {
  if (response.status === 401 || response.status === 403)
    return {
      kind: "failed",
      code: "SOCIAL_PROVIDER_REJECTED",
      retry: "after-reconnect",
    };
  if (response.status === 429)
    return {
      kind: "failed",
      code: "SOCIAL_RATE_LIMITED",
      retry: "after-delay",
      delayMs: 60_000,
    };
  if (
    response.status >= 500 ||
    response.status === 408 ||
    response.status === 409
  )
    return mayPublish ? unknown() : temporary();
  return { kind: "failed", code: "SOCIAL_PROVIDER_REJECTED", retry: "never" };
}

function uploadLocation(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.origin === "https://www.linkedin.com" &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith("/dms-uploads/")
    )
      return url.href;
  } catch {
    return null;
  }
  return null;
}

export const linkedinSender: SocialSender = {
  async send(_scope, input) {
    const author = `urn:li:organization:${input.credentials.externalId}`;
    const headers = linkedinHeaders(input.credentials.accessToken);
    const request = (path: string, body: unknown) =>
      socialFetch(`${LINKEDIN_REST}${path}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const storedImage = input.providerState.linkedinImage;
    let image =
      typeof storedImage === "string" && imageUrn.test(storedImage)
        ? storedImage
        : undefined;
    const media = input.media[0];
    if (media) {
      try {
        if (!image) {
          const initialized = await request("/images?action=initializeUpload", {
            initializeUploadRequest: { owner: author },
          });
          if (!initialized.ok) return refused(initialized, false);
          const { value } = await initialized.json();
          const url = uploadLocation(value?.uploadUrl);
          if (
            !url ||
            typeof value?.image !== "string" ||
            !imageUrn.test(value.image)
          )
            return temporary();
          const uploaded = await socialFetch(url, {
            method: "PUT",
            headers: {
              Authorization: headers.Authorization,
              "Content-Type": media.mime,
            },
            body: new Uint8Array(media.bytes),
          });
          if (!uploaded.ok) return refused(uploaded, false);
          image = value.image as string;
        }
        const found = await socialFetch(
          `${LINKEDIN_REST}/images/${encodeURIComponent(image)}`,
          { headers },
        );
        if (!found.ok) {
          if (found.status === 404) return temporary(image);
          const failure = refused(found, false);
          return failure.kind === "failed" && failure.retry === "after-delay"
            ? { ...failure, providerState: { linkedinImage: image } }
            : failure;
        }
        const details = await found.json();
        if (details.status !== "AVAILABLE")
          return details.status === "PROCESSING_FAILED"
            ? {
                kind: "failed",
                code: "SOCIAL_PROVIDER_REJECTED",
                retry: "never",
              }
            : temporary(image);
      } catch {
        return temporary(image);
      }
    }

    try {
      const posted = await request("/posts", {
        author,
        commentary: input.body,
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
        ...(image ? { content: { media: { id: image } } } : {}),
      });
      if (!posted.ok) {
        const failure = refused(posted, true);
        return image &&
          failure.kind === "failed" &&
          failure.retry === "after-delay"
          ? { ...failure, providerState: { linkedinImage: image } }
          : failure;
      }
      const id = posted.headers.get("x-restli-id");
      if (posted.status !== 201 || !id || !postUrn.test(id)) return unknown();
      return {
        kind: "published",
        externalPostId: id,
        permalink: `https://www.linkedin.com/feed/update/${id}/`,
      };
    } catch (error) {
      return error instanceof ConnectorError && error.outcome === "not_sent"
        ? temporary(image)
        : unknown();
    }
  },
};
