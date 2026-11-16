import type { StructuredDataKind } from "./registry.ts";

// Structured data (schema.org JSON-LD) for a published entry (ADR 0029 §8).
// The delivery API returns it ready to embed; websites put it into
// <script type="application/ld+json"> with `jsonLdScriptContent`.

export interface StructuredDataInput {
  kind: StructuredDataKind;
  url: string;
  locale: string;
  title: string;
  description: string;
  datePublished: Date;
  dateModified: Date;
  image?: { url: string; width: number; height: number } | null;
  authors: readonly { name: string; url?: string; sameAs?: readonly string[] }[];
  publisher: { name: string; url: string; logoUrl?: string };
  faqs?: readonly { question: string; answer: string }[];
  /** Ancestors of the page, home first; the page itself is added last. */
  breadcrumbs?: readonly { name: string; url: string }[];
}

const CONTEXT = "https://schema.org";
/** Google shows at most 110 characters of a headline. */
const headline = (title: string) => (title.length > 110 ? `${title.slice(0, 109).trimEnd()}…` : title);

/** The JSON-LD objects for an entry: its main type, FAQPage and BreadcrumbList where they apply. */
export function structuredData(input: StructuredDataInput): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const authors = input.authors.map((author) => ({
    "@type": "Person",
    name: author.name,
    ...(author.url ? { url: author.url } : {}),
    ...(author.sameAs?.length ? { sameAs: [...author.sameAs] } : {}),
  }));
  const publisher = {
    "@type": "Organization",
    name: input.publisher.name,
    url: input.publisher.url,
    ...(input.publisher.logoUrl ? { logo: { "@type": "ImageObject", url: input.publisher.logoUrl } } : {}),
  };
  const image = input.image
    ? { image: [{ "@type": "ImageObject", url: input.image.url, width: input.image.width, height: input.image.height }] }
    : {};
  if (input.kind === "FAQPage") {
    // A FAQ entry is all questions; the FAQPage object below is its main type.
  } else if (input.kind === "Product") {
    out.push({ "@context": CONTEXT, "@type": "Product", name: input.title, description: input.description, url: input.url, ...image });
  } else {
    out.push({
      "@context": CONTEXT,
      "@type": input.kind,
      headline: headline(input.title),
      description: input.description,
      inLanguage: input.locale,
      mainEntityOfPage: { "@type": "WebPage", "@id": input.url },
      url: input.url,
      datePublished: input.datePublished.toISOString(),
      dateModified: input.dateModified.toISOString(),
      ...(authors.length ? { author: authors } : {}),
      publisher,
      ...image,
    });
  }
  if (input.faqs?.length)
    out.push({
      "@context": CONTEXT,
      "@type": "FAQPage",
      inLanguage: input.locale,
      mainEntity: input.faqs.map((faq) => ({
        "@type": "Question",
        name: faq.question,
        acceptedAnswer: { "@type": "Answer", text: faq.answer },
      })),
    });
  if (input.breadcrumbs?.length) {
    const items = [...input.breadcrumbs, { name: input.title, url: input.url }];
    out.push({
      "@context": CONTEXT,
      "@type": "BreadcrumbList",
      itemListElement: items.map((item, index) => ({ "@type": "ListItem", position: index + 1, name: item.name, item: item.url })),
    });
  }
  return out;
}

/**
 * JSON for an inline <script type="application/ld+json">: `<`, `>`, `&` and
 * the line separators are escaped, so content can never close the script.
 */
export function jsonLdScriptContent(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
