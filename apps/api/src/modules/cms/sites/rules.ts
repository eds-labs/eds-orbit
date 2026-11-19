import { z } from "zod";
import { plainText, type Block, type Inline, type OrbitDoc } from "../../../../../../packages/content-doc/src/index.ts";

// Editorial rules of one site (ADR 0029 §3.2, §7): what a site accepts, for
// example uLiquid's plain-text profile and phrases it never uses. The
// publishing preflight checks them for every site of a publication, so a
// violation stops the request before anyone decides it. Issues name the rule
// and the matched phrases (from the site's own list), never content.

export const contentRules = z
  .object({
    /** Phrases the site never publishes; matched case-insensitively in all text fields. */
    forbiddenPhrases: z.array(z.string().trim().min(2).max(80)).max(100).default([]),
    /**
     * Plain text only: headings, paragraphs and lists without links or
     * formatting (sites whose renderer takes text, not rich content).
     */
    plainText: z.boolean().default(false),
    /** The SEO title (or the title) may not be longer. */
    titleMaxLength: z.int().min(10).max(200).nullable().default(null),
    excerptRequired: z.boolean().default(false),
    heroRequired: z.boolean().default(false),
  })
  .strict();
export type ContentRules = z.infer<typeof contentRules>;

export const storedRules = (raw: unknown): ContentRules => {
  const parsed = contentRules.safeParse(raw ?? {});
  return parsed.success ? parsed.data : contentRules.parse({});
};

export interface RuleContent {
  title: string;
  excerpt?: string | null;
  body: unknown;
  seo: unknown;
  heroAssetId: string | null;
}

export interface RuleViolation {
  rule: keyof ContentRules;
  phrases?: string[];
  blocks?: string[];
}

const seoText = (seo: unknown) => {
  const s = (seo ?? {}) as Record<string, unknown>;
  return ["seoTitle", "metaDescription", "ogTitle", "ogDescription"]
    .map((key) => (typeof s[key] === "string" ? (s[key] as string) : ""))
    .join("\n");
};

const richInline = (items: readonly Inline[]) =>
  items.some((item) => "text" in item && (Boolean(item.link) || Boolean(item.marks?.length)));

/** Block types (and "link"/"formatting") a plain-text site would not render. */
function richParts(blocks: readonly Block[], found: Set<string>) {
  for (const block of blocks) {
    if (block.type === "heading" || block.type === "paragraph") {
      if (richInline(block.content)) found.add("formatting");
    } else if (block.type === "list") for (const item of block.items) richParts(item, found);
    else found.add(block.type);
  }
}

/** The rules of one site the content breaks; empty when it complies. */
export function checkRules(rules: ContentRules, content: RuleContent): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const doc = content.body as OrbitDoc;
  if (rules.forbiddenPhrases.length) {
    const text = [content.title, content.excerpt ?? "", plainText(doc), seoText(content.seo)].join("\n").toLocaleLowerCase();
    const phrases = rules.forbiddenPhrases.filter((phrase) => text.includes(phrase.toLocaleLowerCase()));
    if (phrases.length) violations.push({ rule: "forbiddenPhrases", phrases });
  }
  if (rules.plainText) {
    const found = new Set<string>();
    richParts(doc.blocks, found);
    if (found.size) violations.push({ rule: "plainText", blocks: [...found].sort() });
  }
  if (rules.titleMaxLength) {
    const seoTitle = (content.seo as { seoTitle?: unknown } | null)?.seoTitle;
    const shown = typeof seoTitle === "string" && seoTitle.trim() ? seoTitle : content.title;
    if (shown.length > rules.titleMaxLength) violations.push({ rule: "titleMaxLength" });
  }
  if (rules.excerptRequired && !content.excerpt?.trim()) violations.push({ rule: "excerptRequired" });
  if (rules.heroRequired && !content.heroAssetId) violations.push({ rule: "heroRequired" });
  return violations;
}
