import { z } from "zod";

// Project-wide configuration shared by every module: the content languages
// and the project's public profile links. The UI language is a per-user
// setting (User.locale) and independent of these. The web app keeps a copy
// of the catalogs in apps/web/src/platform/project-settings/catalog.ts; a
// parity test keeps both equal.

/**
 * A language tag, normalized: a two- or three-letter language, an optional
 * four-letter script and an optional region ("pt-BR", "zh-Hant", "sr-Latn-RS").
 */
export const LANGUAGE_CODE_PATTERN =
  /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/;

/** The languages the settings offer first; any other valid tag may be added. */
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

/**
 * The content languages automatic Marketing agents write in: their fact and
 * banner checks are tuned to English and German (decision 2026-10-23).
 */
export const AGENT_CONTENT_LANGUAGES = ["en", "de"] as const;

/** "PT-br" → "pt-BR", "zh-hant" → "zh-Hant"; anything else unchanged. */
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

/**
 * A normalized language tag. No transform, so tool and OpenAPI schemas can
 * describe it; callers normalize input with normalizeLanguageCode first.
 */
export const languageCode = z
  .string()
  .max(20)
  .regex(LANGUAGE_CODE_PATTERN, "Invalid language code");

export const MAX_CONTENT_LANGUAGES = 20;

/** The content languages and the default, which must be one of them. */
export const projectLanguages = z
  .object({
    contentLanguages: z
      .array(languageCode)
      .min(1)
      .max(MAX_CONTENT_LANGUAGES)
      .refine((codes) => new Set(codes).size === codes.length, {
        message: "Each language may appear only once",
      }),
    defaultContentLanguage: languageCode,
  })
  .refine((v) => v.contentLanguages.includes(v.defaultContentLanguage), {
    message: "The default content language must be one of the languages",
    path: ["defaultContentLanguage"],
  });

/**
 * The kinds of profile link. Platform kinds name the hosts their URL must
 * use; the others take any HTTPS address. A link is a public profile, not a
 * publishing channel: channels are connections with their own verification.
 */
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
export const projectLinkTypes = Object.keys(PROJECT_LINK_TYPES) as [
  ProjectLinkType,
  ...ProjectLinkType[],
];

/** Whether a URL's host is (a subdomain of) one the link type names. */
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

export const MAX_PROJECT_LINKS = 40;

export const projectLink = z
  .object({
    type: z.enum(projectLinkTypes),
    label: z.string().trim().min(1).max(80),
    url: z
      .url()
      .max(2000)
      .refine((u) => u.startsWith("https://"), "HTTPS is required"),
  })
  .strict()
  .refine((l) => linkHostAllowed(l.type, l.url), {
    message: "The address does not belong to this platform",
    path: ["url"],
  });
export type ProjectLink = z.infer<typeof projectLink>;

export const projectLinks = z
  .array(projectLink)
  .max(MAX_PROJECT_LINKS)
  .refine((links) => new Set(links.map((l) => l.url)).size === links.length, {
    message: "Each address may appear only once",
  });
