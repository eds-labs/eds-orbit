import { linkAllowed } from "./links.ts";
import {
  CALLOUT_TONES,
  HEADING_LEVELS,
  LIMITS,
  MARKS,
  ORBIT_DOC_SCHEMA,
  ORBIT_DOC_VERSION,
  type OrbitDoc,
} from "./types.ts";

/** Stable problem codes; the API returns them in `error.detail`. */
export type ProblemCode =
  | "not_orbit_doc"
  | "unknown_key"
  | "unknown_block"
  | "block_not_allowed_here"
  | "heading_level"
  | "inline_invalid"
  | "mark_not_allowed"
  | "link_not_allowed"
  | "list_invalid"
  | "children_missing"
  | "callout_tone"
  | "code_invalid"
  | "image_invalid"
  | "too_deep"
  | "too_many_blocks"
  | "text_too_long";

export interface Problem {
  /** JSON path such as `$.blocks[3].content[0]`. */
  path: string;
  code: ProblemCode;
}

export interface ValidationResult {
  valid: boolean;
  problems: Problem[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE_LANGUAGE = /^[a-z0-9][a-z0-9+#.-]*$/;
const MARK_SET = new Set<string>(MARKS);
const TONE_SET = new Set<string>(CALLOUT_TONES);
const LEVEL_SET = new Set<number>(HEADING_LEVELS);

const BLOCK_KEYS: Record<string, readonly string[]> = {
  heading: ["type", "level", "content"],
  paragraph: ["type", "content"],
  list: ["type", "ordered", "items"],
  quote: ["type", "blocks"],
  callout: ["type", "tone", "blocks"],
  code: ["type", "language", "text"],
  image: ["type", "assetId", "caption"],
  divider: ["type"],
};
const NESTED_TYPES = new Set(["paragraph", "list"]);
/** Stop collecting after this many problems; a hostile document should not cost much. */
const MAX_PROBLEMS = 50;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Checks a value against orbit-doc-v1, strictly: unknown keys, nodes and marks
 * are problems, not ignored. This is the security boundary for stored rich
 * text; the editor's configuration is only a convenience.
 */
export function validateOrbitDoc(value: unknown): ValidationResult {
  const problems: Problem[] = [];
  const report = (path: string, code: ProblemCode) => {
    if (problems.length < MAX_PROBLEMS) problems.push({ path, code });
  };
  if (
    !isRecord(value) ||
    value.schema !== ORBIT_DOC_SCHEMA ||
    value.version !== ORBIT_DOC_VERSION ||
    !Array.isArray(value.blocks)
  ) {
    return { valid: false, problems: [{ path: "$", code: "not_orbit_doc" }] };
  }
  for (const key of Object.keys(value)) {
    if (key !== "schema" && key !== "version" && key !== "blocks") report(`$.${key}`, "unknown_key");
  }

  let blockCount = 0;
  let textLength = 0;
  const stop = () => problems.length >= MAX_PROBLEMS || blockCount > LIMITS.blocks;

  const inline = (items: unknown, path: string) => {
    if (!Array.isArray(items)) return report(path, "inline_invalid");
    items.forEach((item, index) => {
      const at = `${path}[${index}]`;
      if (!isRecord(item)) return report(at, "inline_invalid");
      if (item.type === "break") {
        if (Object.keys(item).length !== 1) report(at, "unknown_key");
        return;
      }
      for (const key of Object.keys(item)) {
        if (key !== "text" && key !== "marks" && key !== "link") report(`${at}.${key}`, "unknown_key");
      }
      if (typeof item.text !== "string" || item.text.length === 0) return report(at, "inline_invalid");
      textLength += item.text.length;
      if (item.marks !== undefined) {
        if (!Array.isArray(item.marks) || item.marks.length === 0) report(`${at}.marks`, "mark_not_allowed");
        else {
          const seen = new Set<unknown>();
          for (const mark of item.marks) {
            if (typeof mark !== "string" || !MARK_SET.has(mark) || seen.has(mark)) {
              report(`${at}.marks`, "mark_not_allowed");
            }
            seen.add(mark);
          }
        }
      }
      if (item.link !== undefined) {
        const link = item.link;
        if (!isRecord(link) || Object.keys(link).length !== 1 || !linkAllowed(link.href)) {
          report(`${at}.link`, "link_not_allowed");
        }
      }
    });
  };

  const children = (items: unknown, path: string, depth: number) => {
    if (!Array.isArray(items) || items.length === 0) return report(path, "children_missing");
    items.forEach((child, index) => {
      const at = `${path}[${index}]`;
      if (!isRecord(child) || !NESTED_TYPES.has(child.type as string)) {
        report(at, "block_not_allowed_here");
        return;
      }
      block(child, at, depth);
    });
  };

  const block = (node: unknown, path: string, depth: number): void => {
    if (stop()) return;
    blockCount += 1;
    if (!isRecord(node)) return report(path, "unknown_block");
    const allowed = BLOCK_KEYS[node.type as string];
    if (!allowed) return report(path, "unknown_block");
    if (depth > LIMITS.depth) return report(path, "too_deep");
    for (const key of Object.keys(node)) {
      if (!allowed.includes(key)) report(`${path}.${key}`, "unknown_key");
    }
    switch (node.type) {
      case "heading":
        if (!LEVEL_SET.has(node.level as number)) report(`${path}.level`, "heading_level");
        return inline(node.content, `${path}.content`);
      case "paragraph":
        return inline(node.content, `${path}.content`);
      case "list":
        if (typeof node.ordered !== "boolean") report(`${path}.ordered`, "list_invalid");
        if (!Array.isArray(node.items) || node.items.length === 0) return report(`${path}.items`, "list_invalid");
        node.items.forEach((item, index) => children(item, `${path}.items[${index}]`, depth + 1));
        return;
      case "callout":
        if (!TONE_SET.has(node.tone as string)) report(`${path}.tone`, "callout_tone");
        return children(node.blocks, `${path}.blocks`, depth + 1);
      case "quote":
        return children(node.blocks, `${path}.blocks`, depth + 1);
      case "code":
        if (typeof node.text !== "string" || node.text.length > LIMITS.code) report(`${path}.text`, "code_invalid");
        else textLength += node.text.length;
        if (
          node.language !== null &&
          (typeof node.language !== "string" ||
            node.language.length > LIMITS.codeLanguage ||
            !CODE_LANGUAGE.test(node.language))
        ) {
          report(`${path}.language`, "code_invalid");
        }
        return;
      case "image":
        if (typeof node.assetId !== "string" || !UUID.test(node.assetId)) report(`${path}.assetId`, "image_invalid");
        if (node.caption !== undefined) {
          if (typeof node.caption !== "string" || node.caption.length === 0 || node.caption.length > LIMITS.caption) {
            report(`${path}.caption`, "image_invalid");
          } else textLength += node.caption.length;
        }
        return;
      case "divider":
        return;
    }
  };

  value.blocks.forEach((node, index) => block(node, `$.blocks[${index}]`, 1));
  if (blockCount > LIMITS.blocks) report("$", "too_many_blocks");
  if (textLength > LIMITS.text) report("$", "text_too_long");
  return { valid: problems.length === 0, problems };
}

/** Type guard over {@link validateOrbitDoc}. */
export function isOrbitDoc(value: unknown): value is OrbitDoc {
  return validateOrbitDoc(value).valid;
}

export class OrbitDocError extends Error {
  readonly code = "ORBIT_DOC_INVALID";
  readonly problems: Problem[];
  constructor(problems: Problem[]) {
    super("ORBIT_DOC_INVALID");
    this.name = "OrbitDocError";
    this.problems = problems;
  }
}

/** Returns the value as an {@link OrbitDoc} or throws {@link OrbitDocError}. */
export function assertOrbitDoc(value: unknown): OrbitDoc {
  const result = validateOrbitDoc(value);
  if (!result.valid) throw new OrbitDocError(result.problems);
  return value as OrbitDoc;
}
