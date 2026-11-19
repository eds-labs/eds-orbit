import {
  Extension,
  Node,
  mergeAttributes,
  type Extensions,
} from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import StarterKit from "@tiptap/starter-kit";
import {
  CALLOUT_TONES,
  LIMITS,
  linkAllowed,
  type CalloutTone,
} from "../../../../../../packages/content-doc/src/index.ts";

// The editor's node and mark set (ADR 0029, CH0.2 spike): exactly what
// orbit-doc-v1 can hold, so the editor never produces content the server
// refuses. The mapping lives in packages/content-doc (fromTiptap/toTiptap);
// the server validates every save, so this configuration is a convenience,
// not the security boundary.

const TONES = new Set<string>(CALLOUT_TONES);

/** Callout: an aside with a tone that holds paragraphs and lists. */
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "(paragraph | bulletList | orderedList)+",
  defining: true,
  addAttributes() {
    return {
      tone: {
        default: "info" satisfies CalloutTone,
        parseHTML: (el) => {
          const tone = el.getAttribute("data-tone") ?? "";
          return TONES.has(tone) ? tone : "info";
        },
        renderHTML: (attrs) => ({ "data-tone": attrs.tone }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "aside[data-callout]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "aside",
      mergeAttributes(HTMLAttributes, {
        "data-callout": "",
        class: "cms-callout",
      }),
      0,
    ];
  },
});

export type ImageSource = (assetId: string) => string | null;

/**
 * An image of the content library, referenced by asset id. The preview URL is
 * computed while rendering and never stored; alt text lives on the asset.
 */
export const OrbitImage = Node.create<{ srcOf: ImageSource }>({
  name: "orbitImage",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addOptions() {
    return { srcOf: () => null };
  },
  addAttributes() {
    return {
      assetId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-asset-id"),
        renderHTML: (attrs) => ({ "data-asset-id": attrs.assetId }),
      },
      caption: {
        default: null,
        parseHTML: (el) =>
          el
            .querySelector("figcaption")
            ?.textContent?.slice(0, LIMITS.caption) || null,
        // Rendered as the figcaption below, not as an attribute.
        renderHTML: () => ({}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "figure[data-orbit-image]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const assetId = node.attrs.assetId as string | null;
    const src = assetId ? this.options.srcOf(assetId) : null;
    const caption = (node.attrs.caption as string | null) ?? "";
    return [
      "figure",
      mergeAttributes(HTMLAttributes, {
        "data-orbit-image": "",
        class: "cms-figure",
      }),
      src
        ? ["img", { src, alt: "", draggable: "false" }]
        : ["div", { class: "cms-figure-missing" }],
      ["figcaption", {}, caption],
    ];
  },
});

/** Containers that add one nesting level to the blocks inside them. */
const CONTAINERS = new Set(["listItem", "blockquote", "callout"]);

/** How many containers hold the selection's start (0 at the top level). */
export function containerDepth($from: {
  depth: number;
  node: (depth: number) => { type: { name: string } };
}) {
  let count = 0;
  for (let d = $from.depth; d > 0; d -= 1)
    if (CONTAINERS.has($from.node(d).type.name)) count += 1;
  return count;
}

/**
 * Keeps list indentation inside orbit-doc's nesting limit (LIMITS.depth): a
 * paragraph may sit in at most depth − 1 containers, so Tab stops indenting
 * once one more level would exceed it.
 */
export const NestingLimit = Extension.create({
  name: "orbitNestingLimit",
  // Before the list keymap, which would otherwise sink the item.
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) =>
        containerDepth(editor.state.selection.$from) >= LIMITS.depth - 1,
    };
  },
});

export function editorExtensions({
  placeholder = "",
  srcOf = () => null,
}: { placeholder?: string; srcOf?: ImageSource } = {}): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3, 4] },
      strike: false,
      underline: false,
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
        protocols: ["https", "mailto"],
        isAllowedUri: (url) => linkAllowed(url),
        shouldAutoLink: (url) => linkAllowed(url),
        HTMLAttributes: { rel: "noopener noreferrer", target: null },
      },
    }),
    Placeholder.configure({ placeholder }),
    Callout,
    OrbitImage.configure({ srcOf }),
    NestingLimit,
  ];
}
