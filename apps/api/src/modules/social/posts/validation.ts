import { z } from "zod";
import { instagram } from "@opencoredev/social-sdk/instagram";
import { x } from "@opencoredev/social-sdk/x";
import type { PreparedPublishTarget, PublishContent } from "@opencoredev/social-sdk";
import type { SocialPlatform } from "../accounts/store.ts";
import { carouselIssues, type MediaFacts } from "../media/rules.ts";

// What a platform would refuse, checked before a post is scheduled
// (ADR 0020, S4). The SDK's local checks (`prepareTarget`, no I/O) decide
// X's weighted text length and Instagram's caption; the library's media
// rules decide images; Facebook and Telegram limits are Orbit's own, from
// the platforms' documentation. Validation never blocks saving a draft.

export type ValidationIssue = { code: string; severity: "error" | "warning"; path?: string };
export type VariantFacts = {
  account: {
    id: string;
    platform: SocialPlatform;
    externalId: string;
    status: string;
    capability: string;
    settings: { xLongPosts?: boolean };
  };
  body: string;
  media: MediaFacts[];
  options: Record<string, unknown>;
};

export const TEXT_LIMITS = {
  x: 280,
  xLong: 25_000,
  instagram: 2_200,
  facebook: 63_206,
  telegram: 4_096,
  telegramCaption: 1_024,
} as const;

const OPTIONS: Record<SocialPlatform, z.ZodType> = {
  x: z.object({ replySettings: z.enum(["everyone", "following", "mentionedUsers"]).optional() }).strict(),
  telegram: z.object({ disableLinkPreview: z.boolean().optional(), silent: z.boolean().optional() }).strict(),
  instagram: z.object({}).strict(),
  facebook: z.object({}).strict(),
};

/** The options a variant of the platform may carry. */
export function platformOptions(platform: SocialPlatform): z.ZodType {
  return OPTIONS[platform];
}

// Validation only: a fetch that is never meant to run.
const noNetwork = (() => {
  throw new Error("SOCIAL_VALIDATION_NO_NETWORK");
}) as typeof fetch;

function sdkIssueCodes(platform: "x" | "instagram", externalId: string, content: PublishContent): string[] {
  const target: PreparedPublishTarget = {
    targetIndex: 0,
    targetKey: "validation",
    account: { kind: "connected-account", platform, accountId: externalId } as PreparedPublishTarget["account"],
    content,
  };
  const adapter =
    platform === "x"
      ? x({ auth: { userId: externalId, accessToken: "validation" }, fetch: noNetwork })
      : instagram({ auth: { accessToken: "validation", accountId: externalId, flavor: "facebook-login" }, fetch: noNetwork });
  if (!adapter.posts) throw new Error("SOCIAL_SDK_NO_POSTS");
  return adapter.posts.prepareTarget(target).map((issue) => issue.code);
}

const length = (text: string) => [...text].length;

function textIssues(v: VariantFacts): string[] {
  const { platform, externalId, settings } = v.account;
  const text = v.body;
  switch (platform) {
    case "x":
      if (settings.xLongPosts) return length(text) > TEXT_LIMITS.xLong ? ["SOCIAL_TEXT_TOO_LONG"] : [];
      return sdkIssueCodes("x", externalId, { text }).includes("x.text") ? ["SOCIAL_TEXT_TOO_LONG"] : [];
    case "instagram": {
      // Placeholder HTTPS JPEGs with the real sizes (one square image when
      // there is none) leave only caption issues; media rules decide images.
      const sizes = v.media.length ? v.media.map((m) => [m.jpegWidth, m.jpegHeight]) : [[1080, 1080]];
      const media = sizes.map(([width, height], i) => ({
        kind: "image" as const,
        source: { kind: "https-url" as const, url: `https://media.invalid/${i}.jpg` },
        mimeType: "image/jpeg",
        width,
        height,
      }));
      return sdkIssueCodes("instagram", externalId, { text, media } as PublishContent).includes("instagram.caption")
        ? ["SOCIAL_TEXT_TOO_LONG"]
        : [];
    }
    case "facebook":
      return length(text) > TEXT_LIMITS.facebook ? ["SOCIAL_TEXT_TOO_LONG"] : [];
    case "telegram":
      if (v.media.length) return length(text) > TEXT_LIMITS.telegramCaption ? ["SOCIAL_CAPTION_TOO_LONG"] : [];
      return length(text) > TEXT_LIMITS.telegram ? ["SOCIAL_TEXT_TOO_LONG"] : [];
  }
}

/** The issues of one variant; errors block scheduling, warnings inform. */
export function validateVariant(v: VariantFacts): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (code: string, path?: string) => issues.push({ code, severity: "error", ...(path ? { path } : {}) });
  if (v.account.status !== "active") error("SOCIAL_ACCOUNT_NOT_ACTIVE");
  if (!v.body.trim() && !v.media.length) error("SOCIAL_TEXT_EMPTY", "body");
  else for (const code of textIssues(v)) error(code, "body");
  if (v.account.platform === "instagram" && !v.media.length) error("SOCIAL_MEDIA_REQUIRED", "media");
  if (v.media.length) for (const code of carouselIssues(v.media, v.account.platform)) error(code, "media");
  if (!OPTIONS[v.account.platform].safeParse(v.options).success) error("SOCIAL_OPTIONS_INVALID", "options");
  if (v.account.status === "active" && v.account.capability !== "write_verified")
    issues.push({ code: "SOCIAL_ACCOUNT_NOT_WRITE_VERIFIED", severity: "warning" });
  return issues;
}
