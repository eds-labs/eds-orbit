import { z } from "zod";
import { siteLink } from "./seo.ts";

// Content types (ADR 0029 §3.2, CH1.7) are code, not data: each one names its
// type-specific fields (validated on every save), its structured data and its
// default route. `article` is active; the other slots are defined so routes,
// delivery and approvals already handle them, and are switched on later.

export const faqItem = z
  .object({ question: z.string().trim().min(1).max(200), answer: z.string().trim().min(1).max(2000) })
  .strict();

const link = z.object({ label: z.string().trim().min(1).max(120), href: siteLink }).strict();

export const articleFields = z
  .object({
    /** Questions and answers shown below the article and as FAQPage data. */
    faqs: z.array(faqItem).max(20).default([]),
    /** A short checklist block the website renders as a list. */
    checklist: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
    relatedLinks: z.array(link).max(10).default([]),
    cta: z.object({ label: z.string().trim().min(1).max(60), href: siteLink }).strict().nullable().default(null),
  })
  .strict();

const faqFields = z.object({ items: z.array(faqItem).min(1).max(100) }).strict();
const helpDocFields = z
  .object({ product: z.string().trim().min(1).max(80).nullable().default(null), relatedLinks: z.array(link).max(10).default([]) })
  .strict();
const changelogFields = z
  .object({ version: z.string().trim().min(1).max(40), releasedOn: z.iso.date() })
  .strict();
const productFields = z
  .object({
    sku: z.string().trim().min(1).max(64).nullable().default(null),
    offers: z
      .array(z.object({ price: z.string().regex(/^\d{1,9}(\.\d{1,2})?$/), currency: z.string().regex(/^[A-Z]{3}$/), url: siteLink }).strict())
      .max(5)
      .default([]),
  })
  .strict();

export type StructuredDataKind = "BlogPosting" | "FAQPage" | "TechArticle" | "Article" | "Product";

export interface ContentTypeDef {
  key: string;
  label: { en: string; de: string };
  /** False: defined for later; entries of this type cannot be created yet. */
  enabled: boolean;
  fields: z.ZodType<Record<string, unknown>>;
  /** Main structured data type of an entry. */
  structuredData: StructuredDataKind;
  /** Route pattern used when a site defines none for the type: `{slug}` once. */
  defaultRoute: string;
}

export const CONTENT_TYPES: readonly ContentTypeDef[] = [
  {
    key: "article",
    label: { en: "Article", de: "Artikel" },
    enabled: true,
    fields: articleFields,
    structuredData: "BlogPosting",
    defaultRoute: "/blog/{slug}/",
  },
  { key: "faq", label: { en: "FAQ", de: "FAQ" }, enabled: false, fields: faqFields, structuredData: "FAQPage", defaultRoute: "/faq/{slug}/" },
  {
    key: "help_doc",
    label: { en: "Help article", de: "Hilfeartikel" },
    enabled: false,
    fields: helpDocFields,
    structuredData: "TechArticle",
    defaultRoute: "/help/{slug}/",
  },
  {
    key: "changelog",
    label: { en: "Changelog entry", de: "Changelog-Eintrag" },
    enabled: false,
    fields: changelogFields,
    structuredData: "Article",
    defaultRoute: "/changelog/{slug}/",
  },
  {
    key: "product",
    label: { en: "Product information", de: "Produktinformation" },
    enabled: false,
    fields: productFields,
    structuredData: "Product",
    defaultRoute: "/products/{slug}/",
  },
];

const byKey = new Map(CONTENT_TYPES.map((def) => [def.key, def]));

/** The type definition, or undefined for an unknown key. */
export const contentType = (key: string) => byKey.get(key);

/** The type if it may be used for new entries now; else throws CMS_TYPE_UNAVAILABLE. */
export function enabledContentType(key: string) {
  const def = byKey.get(key);
  if (!def?.enabled) throw Object.assign(new Error("CMS_TYPE_UNAVAILABLE"), { code: "CMS_TYPE_UNAVAILABLE" });
  return def;
}

/** Validates and completes a type's fields (defaults filled in). */
export function parseFields(typeKey: string, raw: unknown) {
  const def = byKey.get(typeKey);
  if (!def) throw Object.assign(new Error("CMS_TYPE_UNKNOWN"), { code: "CMS_TYPE_UNKNOWN" });
  return def.fields.parse(raw ?? {}) as Record<string, unknown>;
}
