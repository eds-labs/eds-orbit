# CH0.2: TipTap and orbit-doc-v1 spike

Work package CH0.2 of [CONTENT_HUB.md](CONTENT_HUB.md), 2026-11-14. Throw-away prototype in the session scratch directory; nothing in the repository depends on it. No package manifest or lockfile of Orbit changed. The version proposal below is decision D-B and needs Mario's approval before CH1.14b adds the packages.

## Result in short

- TipTap 3 maps 1:1 onto a small Orbit block format. A document went through the real ProseMirror schema and back without loss, covering every block and mark of the planned set.
- TipTap's own HTML parser removes scripts, event handlers, `javascript:` and `http:` links, iframes and external images on paste. What it keeps always passes the Orbit validator, except for lists nested deeper than the limit.
- The editor costs about **129 KiB gzip** (407 KiB minified) on top of React, so it must be loaded only on the editor page.
- Proposal D-B: pin **five packages at exactly `3.32.2`** (released 2026-10-30, the newest release at least 14 days old; 3.34.0 from 2026-11-13 is too fresh). Together with their dependencies that is 51 packages, all MIT.

## Version proposal (D-B)

| Package | Version | Why |
| --- | --- | --- |
| `@tiptap/react` | 3.32.2 | `useEditor`, `EditorContent`; peer range React 17–19 covers React 19.3.0 in `apps/web` |
| `@tiptap/core` | 3.32.2 | peer of `@tiptap/react`, needed for the custom nodes (`Node.create`) |
| `@tiptap/pm` | 3.32.2 | ProseMirror bundle (peer) |
| `@tiptap/starter-kit` | 3.32.2 | headings, paragraph, lists, quote, code block, horizontal rule, bold, italic, inline code, hard break, link, history |
| `@tiptap/extensions` | 3.32.2 | `Placeholder` |

These are added only to `apps/web`, with exact versions as the repository already pins them. Not needed: `@tiptap/extension-image` (Orbit uses its own asset-referencing image node), a separate `@tiptap/extension-link` (it comes with the starter kit in TipTap 3), `@tiptap/html` (the server renders with Orbit's own renderer). `packages/content-doc` needs no TipTap dependency, because the mapping is a plain JSON transform. Licenses: 51 packages, all MIT; the only third-party runtime libraries are `prosemirror-*`, `linkifyjs`, `fast-equals` and `use-sync-external-store`.

## orbit-doc-v1 (draft format, input for CH1.5)

```
{ schema: "orbit-doc", version: 1, blocks: Block[] }

Block  = { type: "heading", level: 2 | 3 | 4, content: Inline[] }
       | { type: "paragraph", content: Inline[] }
       | { type: "list", ordered: boolean, items: Block[][] }       // items hold paragraphs and lists
       | { type: "quote", blocks: Block[] }                           // paragraphs and lists
       | { type: "callout", tone: "info" | "tip" | "warning", blocks: Block[] }
       | { type: "code", language: string | null, text: string }
       | { type: "image", assetId: uuid, caption?: string }           // alt text lives on the asset, per locale
       | { type: "divider" }

Inline = { text: string, marks?: ("bold" | "italic" | "code")[], link?: { href } }
       | { type: "break" }
```

- Links: `https:`, `mailto:`, site-relative paths (`/…`, not `//…`) and `#anchors`; no control characters or whitespace; at most 2,048 characters.
- Limits used in the spike: 2,000 blocks, nesting depth 4, 200,000 characters of text, captions 300, code 20,000.
- No raw HTML block and no free attributes, so a stored document cannot carry markup.
- FAQ stays a type field (`fields.faqs`), not a body block, because JSON-LD `FAQPage` needs it structured and websites render it separately.

## Mapping TipTap ↔ orbit-doc-v1

| TipTap node / mark | orbit-doc-v1 |
| --- | --- |
| `heading` (levels 2–4 only) | `heading` |
| `paragraph` (empty ones are dropped on save) | `paragraph` |
| `bulletList` / `orderedList` → `listItem` | `list` with `ordered` |
| `blockquote` | `quote` |
| custom `callout` (`aside[data-callout]`, attr `tone`) | `callout` |
| `codeBlock` (attr `language`) | `code` |
| custom `orbitImage` (attrs `assetId`, `caption`; editor-only `previewSrc` is never stored) | `image` |
| `horizontalRule` | `divider` |
| `hardBreak` | `{ type: "break" }` |
| marks `bold`, `italic`, `code` | `marks` |
| mark `link` (`href`) | `link` |
| anything else | not mapped, reported as dropped |

Starter kit configuration: `heading.levels [2,3,4]`, `strike: false`, `underline: false`, link with `openOnClick: false`, `protocols ["https","mailto"]`, `isAllowedUri` = the same link rule as the validator, `rel="noopener noreferrer"`.

## Checks run

All in the prototype, Node 24.18.0:

| Check | Result |
| --- | --- |
| Valid sample (all blocks and marks, nested list, German umlauts) | PASS |
| Roundtrip orbit → TipTap → editor schema (`Editor.getJSON`) → orbit, byte-identical, nothing dropped | PASS |
| Validator rejects `javascript:`, protocol-relative and `http:` links, `h1`, raw HTML blocks, unknown marks, images without an asset id | PASS (7 cases) |
| Renderer escapes text, attributes and code (`<img onerror>`, quote breakout in `href`, `</code><script>`) | PASS |
| Renderer resolves images through an asset lookup (width, height, alt) | PASS |
| Plain text and table of contents (anchor `grosse-ubersicht` for "Größe & Übersicht") | PASS |

Paste through TipTap's HTML parser (`generateJSON`), then mapping and validation:

| Pasted HTML | What remains | Valid |
| --- | --- | --- |
| `<p onclick>` + `<script>` + external `<img onerror>` | text "Hi" only | yes |
| `javascript:`, `http:` and `https:` links | only the `https:` link stays a link; the others become text | yes |
| Word-like `h1`, `h5`, styled `span`, `<u>`, `<s>` | `h1` and `h5` become paragraphs; bold kept; underline and strike become text | yes |
| table and `<iframe>` | iframe removed; the table becomes one paragraph "AB" (cells glued together) | yes |
| Google Docs wrapper (`<b id="docs-internal-guid">`) | bold and normal text correct | yes |
| list nested 5 levels deep | kept by the editor | **no** (depth limit) |

## Consequences for CH1.5 and CH1.14b

1. **Normalize pasted HTML** (`transformPastedHTML`) before TipTap parses it: `h1` → `h2`, `h5`/`h6` → `h4`; table cells → one paragraph per row with cells separated, until tables are supported; tell the editor when external images or `http:` links were removed, and offer the media library import for images.
2. **One nesting limit in editor and validator:** block list indent beyond three levels in the editor and flatten deeper levels on paste, so the editor never produces a document the server refuses.
3. **Load the editor lazily** (`next/dynamic`, editor route only, `immediatelyRender: false` for SSR).
4. **Validate on the server** on every save; the TipTap configuration is a convenience, not the security boundary. Rendering uses the escaping renderer plus `sanitize-html`, as planned.
5. **Empty paragraphs** are dropped on save, so a saved document has none; the editor keeps them while typing.
6. **Upgrades** follow the normal dependency workflow; a version is taken only once it is at least 14 days old.
