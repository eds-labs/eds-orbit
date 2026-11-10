// A social platform's name and a small mark beside it (WP3, 2026-11-10).
// Lucide has no brand icons and no brand artwork is shipped, so the mark is
// a letter badge; it is decorative (aria-hidden) and always sits next to the
// platform's name, never instead of it.

const PLATFORMS: Record<string, { name: string; mark: string }> = {
  facebook: { name: "Facebook", mark: "f" },
  instagram: { name: "Instagram", mark: "IG" },
  x: { name: "X", mark: "X" },
  twitter: { name: "X", mark: "X" },
  telegram: { name: "Telegram", mark: "TG" },
  linkedin: { name: "LinkedIn", mark: "in" },
  threads: { name: "Threads", mark: "@" },
  tiktok: { name: "TikTok", mark: "TT" },
  youtube: { name: "YouTube", mark: "YT" },
  pinterest: { name: "Pinterest", mark: "P" },
  bluesky: { name: "Bluesky", mark: "B" },
  mastodon: { name: "Mastodon", mark: "M" },
  reddit: { name: "Reddit", mark: "R" },
};

/**
 * The platform behind a channel identifier: Social's platform ("instagram")
 * or Postiz's identifier ("instagram-standalone", "linkedin-page"); null
 * when it names no platform this table knows.
 */
export function platformKey(identifier: unknown): string | null {
  if (typeof identifier !== "string" || !identifier) return null;
  const word = identifier.toLowerCase().split(/[-_:\s]/)[0]!;
  return word in PLATFORMS ? word : null;
}

/** The platform's name as people write it, else null. */
export function platformName(identifier: unknown): string | null {
  const key = platformKey(identifier);
  return key ? PLATFORMS[key]!.name : null;
}

/** The decorative mark of a platform; nothing for an unknown one. */
export function PlatformMark({ platform }: { platform: unknown }) {
  const key = platformKey(platform);
  if (!key) return null;
  return (
    <span className={`platform-mark platform-mark-${key}`} aria-hidden="true">
      {PLATFORMS[key]!.mark}
    </span>
  );
}
