import { isExternalLink, linkAllowed } from "./links.ts";
import { tableOfContents } from "./text.ts";
import { isLineBreak, type Block, type Inline, type OrbitDoc } from "./types.ts";

/** What the renderer needs to know about an image asset in the target locale. */
export interface RenderedAsset {
  src: string;
  width: number;
  height: number;
  alt: string;
  srcset?: string;
  sizes?: string;
}

export interface RenderOptions {
  /** Resolves an asset id; `null` leaves the image out (e.g. unpublished asset). */
  resolveAsset?: (assetId: string) => RenderedAsset | null;
  /** Origins that count as the site itself: links there get no `rel`. */
  siteOrigins?: readonly string[];
}

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text and attribute values. */
export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => ENTITIES[char]!);

const dimension = (value: number): number => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

/** Only plain URLs or root-relative paths may become `src`/`srcset`. */
const safeSource = (value: string): boolean =>
  /^(https:\/\/|\/(?!\/))/.test(value) && !/[\s"'<>\\]/.test(value);

/**
 * Renders a validated orbit-doc-v1 document to HTML. Every text and attribute
 * is escaped and links are rechecked here, so the output carries no markup
 * from content. The API applies `sanitize-html` on top as a second layer.
 * Headings get ids that match {@link tableOfContents}.
 */
export function renderHtml(doc: OrbitDoc, options: RenderOptions = {}): string {
  const { resolveAsset = () => null, siteOrigins = [] } = options;
  const anchors = tableOfContents(doc).map((entry) => entry.anchor);
  let headingIndex = 0;

  const inline = (items: readonly Inline[]): string =>
    items
      .map((item) => {
        if (isLineBreak(item)) return "<br>";
        let html = escapeHtml(item.text);
        // Innermost first so the canonical order bold > italic > code nests predictably.
        for (const mark of [...(item.marks ?? [])].reverse()) {
          if (mark === "code") html = `<code>${html}</code>`;
          else if (mark === "italic") html = `<em>${html}</em>`;
          else if (mark === "bold") html = `<strong>${html}</strong>`;
        }
        const href = item.link?.href;
        if (href && linkAllowed(href)) {
          const rel = isExternalLink(href, siteOrigins) ? ' rel="noopener noreferrer"' : "";
          html = `<a href="${escapeHtml(href)}"${rel}>${html}</a>`;
        }
        return html;
      })
      .join("");

  const block = (node: Block): string => {
    switch (node.type) {
      case "heading": {
        const level = node.level === 3 || node.level === 4 ? node.level : 2;
        const anchor = anchors[headingIndex++];
        const id = anchor ? ` id="${escapeHtml(anchor)}"` : "";
        return `<h${level}${id}>${inline(node.content)}</h${level}>`;
      }
      case "paragraph":
        return `<p>${inline(node.content)}</p>`;
      case "list": {
        const tag = node.ordered ? "ol" : "ul";
        return `<${tag}>${node.items.map((item) => `<li>${item.map(block).join("")}</li>`).join("")}</${tag}>`;
      }
      case "quote":
        return `<blockquote>${node.blocks.map(block).join("")}</blockquote>`;
      case "callout": {
        const tone = node.tone === "tip" || node.tone === "warning" ? node.tone : "info";
        return `<aside class="callout callout-${tone}" data-tone="${tone}">${node.blocks.map(block).join("")}</aside>`;
      }
      case "code": {
        const language =
          node.language && /^[a-z0-9][a-z0-9+#.-]*$/.test(node.language)
            ? ` class="language-${escapeHtml(node.language)}"`
            : "";
        return `<pre><code${language}>${escapeHtml(node.text)}</code></pre>`;
      }
      case "image": {
        const asset = resolveAsset(node.assetId);
        if (!asset || !safeSource(asset.src)) return "";
        const srcset =
          asset.srcset && asset.srcset.split(",").every((part) => safeSource(part.trim().split(/\s+/)[0] ?? ""))
            ? ` srcset="${escapeHtml(asset.srcset)}"${asset.sizes ? ` sizes="${escapeHtml(asset.sizes)}"` : ""}`
            : "";
        const caption = node.caption ? `<figcaption>${escapeHtml(node.caption)}</figcaption>` : "";
        return (
          `<figure><img src="${escapeHtml(asset.src)}"${srcset} width="${dimension(asset.width)}" ` +
          `height="${dimension(asset.height)}" alt="${escapeHtml(asset.alt)}" loading="lazy" decoding="async">` +
          `${caption}</figure>`
        );
      }
      case "divider":
        return "<hr>";
    }
  };

  return doc.blocks.map(block).join("\n");
}
