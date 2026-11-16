import { z } from "zod";
import { linkAllowed } from "../../../../../../packages/content-doc/src/index.ts";

// SEO fields of a draft or revision (ADR 0029 §8). Lengths are hard limits
// against abuse; the editor's checks recommend shorter values (CH1.14b).

const text = (max: number) => z.string().trim().min(1).max(max);

/** An absolute HTTPS URL without credentials. */
export const httpsUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "HTTPS URL without credentials");

/** A link a website may render: https, mailto, site-relative or an anchor. */
export const siteLink = z.string().trim().max(2048).refine((value) => linkAllowed(value), "link not allowed");

export const seoSchema = z
  .object({
    seoTitle: text(70).optional(),
    metaDescription: text(170).optional(),
    canonicalOverride: httpsUrl.optional(),
    robots: z.object({ index: z.boolean(), follow: z.boolean() }).strict().optional(),
    ogTitle: text(95).optional(),
    ogDescription: text(200).optional(),
    ogImageAssetId: z.uuid().optional(),
    focusKeyword: text(80).optional(),
    keywords: z.array(text(60)).max(10).optional(),
  })
  .strict();
export type Seo = z.infer<typeof seoSchema>;

/** Recommended ranges the editor shows; not enforced. */
export const SEO_RECOMMENDED = {
  seoTitle: { min: 30, max: 60 },
  metaDescription: { min: 70, max: 155 },
} as const;
