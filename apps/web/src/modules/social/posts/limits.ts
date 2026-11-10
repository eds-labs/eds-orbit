import type { SocialPlatform } from "../api";

// Text limits as hints while typing (S4). The server decides with the
// platforms' own rules (modules/social/posts/validation.ts): X's weighting
// is approximated here by counting each link as 23 characters.

const LIMITS = { x: 280, xLong: 25_000, instagram: 2_200, facebook: 63_206, telegram: 4_096, telegramCaption: 1_024 };
const URL = /https?:\/\/\S+/g;

export function textHint(
  platform: SocialPlatform,
  text: string,
  opts: { xLongPosts?: boolean; hasMedia: boolean },
): { used: number; limit: number; over: boolean } {
  const used = platform === "x" ? [...text.replace(URL, "x".repeat(23))].length : [...text].length;
  const limit =
    platform === "x"
      ? opts.xLongPosts
        ? LIMITS.xLong
        : LIMITS.x
      : platform === "telegram"
        ? opts.hasMedia
          ? LIMITS.telegramCaption
          : LIMITS.telegram
        : LIMITS[platform];
  return { used, limit, over: used > limit };
}
