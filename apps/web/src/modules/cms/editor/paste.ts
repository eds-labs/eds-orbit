import { linkAllowed } from "../../../../../../packages/content-doc/src/index.ts";

// Pasted HTML, before TipTap parses it (CH0.2 spike, consequence 1). It only
// reshapes what orbit-doc cannot hold so the author keeps the text: h1 → h2,
// h5/h6 → h4, a table row → one paragraph with its cells separated. The
// editor schema, the mapping (fromTiptap) and the server validation remove
// everything else; this is no security boundary.

export type PasteNotice = { images: number; links: number };

const HREF = /\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;

function decode(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** Reshapes pasted HTML and counts the images and links the editor will drop. */
export function normalizePastedHtml(html: string): {
  html: string;
  notice: PasteNotice;
} {
  // Images from elsewhere carry no content asset; Orbit's own figures do.
  const images =
    (html.match(/<img\b/gi) ?? []).length -
    (html.match(/<figure\b[^>]*data-orbit-image/gi) ?? []).length;
  let links = 0;
  for (const match of html.matchAll(HREF)) {
    const href = decode(match[2] ?? match[3] ?? match[4] ?? "");
    if (!linkAllowed(href)) links += 1;
  }
  const out = html
    .replace(/<(\/?)h1(\s|>)/gi, "<$1h2$2")
    .replace(/<(\/?)h[56](\s|>)/gi, "<$1h4$2")
    // Tables are not supported yet: one paragraph per row, cells separated.
    .replace(/<\/(td|th)\s*>/gi, " · ")
    .replace(/<(td|th)\b[^>]*>/gi, "")
    .replace(/<tr\b[^>]*>/gi, "<p>")
    .replace(/(?:\s·\s)?\s*<\/tr\s*>/gi, "</p>")
    .replace(
      /<\/?(table|thead|tbody|tfoot|caption|colgroup|col)\b[^>]*>/gi,
      "",
    );
  return { html: out, notice: { images: Math.max(0, images), links } };
}
