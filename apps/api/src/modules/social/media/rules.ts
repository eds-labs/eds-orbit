import type { SocialPlatform } from "../accounts/store.ts";

// Which rendition of a library image each platform gets, and what the
// platform would refuse (ADR 0020, S3). Values from the platforms' own
// limits (docs/SOCIAL.md, "Platform constraints") and the SDK 0.5.0 checks:
// Instagram takes JPEG only (4:5 to 1.91:1, ≥ 320 px wide, ≤ 8 MB, carousel
// of equal ratios); X takes JPEG or PNG ≤ 5 MiB, up to four; Facebook and
// Telegram take the original up to 10 MB.

export type MediaFacts = {
  mime: string;
  width: number;
  height: number;
  size: number;
  jpegWidth: number;
  jpegHeight: number;
  jpegSize: number;
};
export type Rendition = "original" | "jpeg";

const MiB = 1024 * 1024;
const EPSILON = 0.001;
const MAX_ITEMS: Record<SocialPlatform, number> = { instagram: 10, x: 4, facebook: 10, telegram: 10 };

const ratioOf = (width: number, height: number) => width / height;

export function renditionFor(media: MediaFacts, platform: SocialPlatform): Rendition {
  switch (platform) {
    case "instagram":
      return "jpeg";
    case "x":
      return media.size <= 5 * MiB ? "original" : "jpeg";
    case "facebook":
      return media.size <= 10_000_000 ? "original" : "jpeg";
    case "telegram":
      return media.size <= 10 * MiB ? "original" : "jpeg";
  }
}

export function mediaIssues(media: MediaFacts, platform: SocialPlatform): string[] {
  const issues: string[] = [];
  if (platform === "instagram") {
    const r = ratioOf(media.jpegWidth, media.jpegHeight);
    if (r < 0.8 - EPSILON || r > 1.91 + EPSILON) issues.push("SOCIAL_MEDIA_ASPECT_RATIO");
    if (media.jpegWidth < 320) issues.push("SOCIAL_MEDIA_TOO_SMALL");
    if (media.jpegSize > 8_000_000) issues.push("SOCIAL_MEDIA_TOO_LARGE");
  } else if (platform === "x") {
    const size = renditionFor(media, "x") === "original" ? media.size : media.jpegSize;
    if (size > 5 * MiB) issues.push("SOCIAL_MEDIA_TOO_LARGE");
  } else if (platform === "telegram") {
    if (media.width + media.height > 10_000) issues.push("SOCIAL_MEDIA_DIMENSIONS");
    if (Math.max(media.width / media.height, media.height / media.width) > 20) issues.push("SOCIAL_MEDIA_ASPECT_RATIO");
  } else if (platform === "facebook") {
    if (renditionFor(media, "facebook") === "jpeg" && media.jpegSize > 10_000_000) issues.push("SOCIAL_MEDIA_TOO_LARGE");
  }
  return issues;
}

/** Issues of several images in one post, each code once. */
export function carouselIssues(items: MediaFacts[], platform: SocialPlatform): string[] {
  const issues = new Set(items.flatMap((item) => mediaIssues(item, platform)));
  if (items.length > MAX_ITEMS[platform]) issues.add("SOCIAL_MEDIA_TOO_MANY");
  if (platform === "instagram" && items.length > 1) {
    const first = ratioOf(items[0]!.jpegWidth, items[0]!.jpegHeight);
    if (items.some((item) => Math.abs(ratioOf(item.jpegWidth, item.jpegHeight) - first) > EPSILON))
      issues.add("SOCIAL_MEDIA_CAROUSEL_RATIO");
  }
  return [...issues];
}
