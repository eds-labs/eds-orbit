import type { Locale } from "@/lib/i18n";

// The web copy of packages/schemas/src/project-settings.ts (the web app
// imports no runtime code from packages; catalog.test.tsx keeps both equal).
// The server validates again; these helpers only guide the editors.

export const LANGUAGE_CODE_PATTERN =
  /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/;

export const COMMON_CONTENT_LANGUAGES = [
  "en",
  "de",
  "fr",
  "es",
  "it",
  "pt",
  "pt-BR",
  "nl",
  "pl",
  "cs",
  "sk",
  "sl",
  "hr",
  "hu",
  "ro",
  "bg",
  "el",
  "tr",
  "uk",
  "ru",
  "sv",
  "da",
  "nb",
  "fi",
  "et",
  "lv",
  "lt",
  "ar",
  "he",
  "hi",
  "id",
  "vi",
  "th",
  "ja",
  "ko",
  "zh-Hans",
  "zh-Hant",
] as const;

export const AGENT_CONTENT_LANGUAGES = ["en", "de"] as const;
export const MAX_CONTENT_LANGUAGES = 20;
export const MAX_PROJECT_LINKS = 40;

export function normalizeLanguageCode(raw: string): string {
  return raw
    .trim()
    .replace(/_/g, "-")
    .split("-")
    .map((part, i) =>
      i === 0
        ? part.toLowerCase()
        : part.length === 4
          ? part[0]!.toUpperCase() + part.slice(1).toLowerCase()
          : part.toUpperCase(),
    )
    .join("-");
}

/** "pt-BR" → "Portuguese (Brazil)" / "Portugiesisch (Brasilien)"; the code if unknown. */
export function languageName(code: string, locale: Locale): string {
  try {
    const name = new Intl.DisplayNames([locale], {
      type: "language",
      fallback: "none",
    }).of(code);
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}

export const PROJECT_LINK_TYPES = {
  website: { group: "web", hosts: [] },
  web_app: { group: "web", hosts: [] },
  documentation: { group: "web", hosts: [] },
  blog: { group: "web", hosts: [] },
  support: { group: "web", hosts: [] },
  x: { group: "social", hosts: ["x.com", "twitter.com"] },
  linkedin: { group: "social", hosts: ["linkedin.com"] },
  telegram: { group: "social", hosts: ["t.me", "telegram.me"] },
  instagram: { group: "social", hosts: ["instagram.com"] },
  facebook: { group: "social", hosts: ["facebook.com", "fb.com"] },
  tiktok: { group: "social", hosts: ["tiktok.com"] },
  youtube: { group: "social", hosts: ["youtube.com", "youtu.be"] },
  threads: { group: "social", hosts: ["threads.net", "threads.com"] },
  bluesky: { group: "social", hosts: ["bsky.app"] },
  pinterest: {
    group: "social",
    hosts: [
      "pinterest.com",
      "pinterest.de",
      "pinterest.at",
      "pinterest.ch",
      "pinterest.co.uk",
      "pin.it",
    ],
  },
  discord: { group: "social", hosts: ["discord.gg", "discord.com"] },
  app_store: { group: "app", hosts: ["apps.apple.com"] },
  google_play: { group: "app", hosts: ["play.google.com"] },
  custom: { group: "other", hosts: [] },
} as const satisfies Record<
  string,
  { group: "web" | "social" | "app" | "other"; hosts: readonly string[] }
>;
export type ProjectLinkType = keyof typeof PROJECT_LINK_TYPES;
export type ProjectLinkGroup =
  (typeof PROJECT_LINK_TYPES)[ProjectLinkType]["group"];
export type ProjectLink = { type: ProjectLinkType; label: string; url: string };

export const LINK_TYPE_LABELS: Record<
  ProjectLinkType,
  { en: string; de: string }
> = {
  website: { en: "Website", de: "Website" },
  web_app: { en: "Web app", de: "Web-App" },
  documentation: { en: "Documentation", de: "Dokumentation" },
  blog: { en: "Blog", de: "Blog" },
  support: { en: "Support / help", de: "Support / Hilfe" },
  x: { en: "X", de: "X" },
  linkedin: { en: "LinkedIn", de: "LinkedIn" },
  telegram: { en: "Telegram", de: "Telegram" },
  instagram: { en: "Instagram", de: "Instagram" },
  facebook: { en: "Facebook", de: "Facebook" },
  tiktok: { en: "TikTok", de: "TikTok" },
  youtube: { en: "YouTube", de: "YouTube" },
  threads: { en: "Threads", de: "Threads" },
  bluesky: { en: "Bluesky", de: "Bluesky" },
  pinterest: { en: "Pinterest", de: "Pinterest" },
  discord: { en: "Discord", de: "Discord" },
  app_store: { en: "App Store", de: "App Store" },
  google_play: { en: "Google Play", de: "Google Play" },
  custom: { en: "Other link", de: "Anderer Link" },
};

export const LINK_GROUP_LABELS: Record<
  ProjectLinkGroup,
  { en: string; de: string }
> = {
  web: { en: "Web", de: "Web" },
  social: { en: "Social media", de: "Social Media" },
  app: { en: "App stores", de: "App-Stores" },
  other: { en: "Other", de: "Sonstige" },
};

export function isLinkType(value: unknown): value is ProjectLinkType {
  return typeof value === "string" && value in PROJECT_LINK_TYPES;
}

export function linkHostAllowed(type: ProjectLinkType, url: string): boolean {
  const hosts: readonly string[] = PROJECT_LINK_TYPES[type].hosts;
  if (!hosts.length) return true;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

export type LinkProblem =
  | "label_required"
  | "url_invalid"
  | "https_required"
  | "host_mismatch"
  | "duplicate";

/** The first problem of each link (by index), as the server would refuse it. */
export function linkProblems(
  links: readonly ProjectLink[],
): Array<LinkProblem | null> {
  const seen = new Set<string>();
  return links.map((link) => {
    if (!link.label.trim()) return "label_required";
    let parsed: URL;
    try {
      parsed = new URL(link.url.trim());
    } catch {
      return "url_invalid";
    }
    if (parsed.protocol !== "https:") return "https_required";
    if (!linkHostAllowed(link.type, link.url.trim())) return "host_mismatch";
    const key = link.url.trim();
    if (seen.has(key)) return "duplicate";
    seen.add(key);
    return null;
  });
}

/** The saved links of a project, defensively: unknown types become custom. */
export function projectLinksOf(raw: unknown): ProjectLink[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const { type, label, url } = item as Record<string, unknown>;
    if (typeof url !== "string" || typeof label !== "string") return [];
    return [{ type: isLinkType(type) ? type : "custom", label, url }];
  });
}
