/**
 * orbit-doc-v1: schema, validation, canonical form, HTML/text rendering and
 * the TipTap mapping for the Content module (ADR 0029, CH1.5). Pure functions
 * without I/O or dependencies, so the API, the worker and the web editor share
 * one implementation.
 */
export * from "./types.ts";
export { linkAllowed, isExternalLink } from "./links.ts";
export {
  validateOrbitDoc,
  isOrbitDoc,
  assertOrbitDoc,
  OrbitDocError,
  type Problem,
  type ProblemCode,
  type ValidationResult,
} from "./validate.ts";
export { canonicalize, canonicalInline, canonicalJson, fitNesting, type FitResult } from "./normalize.ts";
export {
  plainText,
  wordCount,
  readingTimeMinutes,
  slugify,
  tableOfContents,
  excerpt,
  referencedAssetIds,
  linkTargets,
  type TocEntry,
} from "./text.ts";
export { renderHtml, escapeHtml, type RenderOptions, type RenderedAsset } from "./render.ts";
export {
  fromTiptap,
  toTiptap,
  type TiptapNode,
  type TiptapMark,
  type TiptapChange,
  type TiptapChangeCode,
} from "./tiptap.ts";
