import type { AssignmentFormat } from "./assignments.ts";

/**
 * Deterministic format checks of an assignment draft (R77). The length is
 * the body as written, in Unicode characters, without the link Orbit
 * appends; it may fall short of the range by a tenth of `minChars` and
 * exceed it by a twentieth of `maxChars` (a model does not count characters
 * exactly; less room above, since a long body runs into channel limits such
 * as Telegram's 1,024-character caption). Hashtags (`#word`) are counted
 * exactly. Paragraphs are asked for in the prompt but not checked.
 * The review lets the copywriter revise a draft once for these problems
 * alone; a revision that still misses them is rejected.
 */
export const FORMAT_LENGTH = "FORMAT_LENGTH";
export const FORMAT_HASHTAGS = "FORMAT_HASHTAGS";
export const FORMAT_PROBLEMS = new Set([FORMAT_LENGTH, FORMAT_HASHTAGS]);
export const FORMAT_SHORT_TOLERANCE_PERCENT = 10;
export const FORMAT_LONG_TOLERANCE_PERCENT = 5;

const HASHTAG = /(?:^|[^\p{L}\p{N}_&#/])#[\p{L}\p{N}_]+/gu;

/** Characters of a body as the format counts them. */
export const formatLength = (body: unknown) =>
  Array.from(String(body ?? "").trim()).length;

/** Hashtags in a body. */
export const hashtagCount = (body: unknown) =>
  [...String(body ?? "").matchAll(HASHTAG)].length;

/** The accepted length range of a format, tolerance included. */
export function lengthRange(format: AssignmentFormat) {
  return {
    min: Math.floor(
      (format.minChars * (100 - FORMAT_SHORT_TOLERANCE_PERCENT)) / 100,
    ),
    max: Math.ceil(
      (format.maxChars * (100 + FORMAT_LONG_TOLERANCE_PERCENT)) / 100,
    ),
  };
}

/** The format problems of a body; none without a format. */
export function formatProblems(
  body: unknown,
  format: AssignmentFormat | null | undefined,
) {
  if (!format) return [];
  const problems: string[] = [];
  const range = lengthRange(format);
  const length = formatLength(body);
  if (length < range.min || length > range.max) problems.push(FORMAT_LENGTH);
  const tags = hashtagCount(body);
  if (tags < format.hashtags.min || tags > format.hashtags.max)
    problems.push(FORMAT_HASHTAGS);
  return problems;
}

/** The copywriter's revision instruction for format problems: what to change, never new claims. */
export function formatInstruction(
  body: unknown,
  format: AssignmentFormat,
  problems: string[],
) {
  const parts: string[] = [];
  if (problems.includes(FORMAT_LENGTH))
    parts.push(
      `make the body ${format.minChars} to ${format.maxChars} characters long (it has ${formatLength(body)}; the appended link does not count)${format.paragraphs ? " in short paragraphs separated by one blank line" : ""}, expanding or tightening only what it already says`,
    );
  if (problems.includes(FORMAT_HASHTAGS))
    parts.push(
      `end it with ${format.hashtags.min === format.hashtags.max ? format.hashtags.min : `${format.hashtags.min} to ${format.hashtags.max}`} hashtags that name topics only (it has ${hashtagCount(body)})`,
    );
  return `Rewrite the post to fit the assignment's format: ${parts.join("; ")}. Keep its facts, call to action and link, and add no new claim, figure or link.`;
}
