import type { FormatId } from "./ids.ts";

/** Distance in pixels that text and logos keep from each canvas edge. */
export type Insets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};
export type CreativeFormat = {
  id: FormatId;
  width: number;
  height: number;
  safe: Insets;
};
const even = (n: number): Insets => ({ top: n, right: n, bottom: n, left: n });
/** Canvas size and safe area per format; story reserves room for platform UI. */
export const CREATIVE_FORMATS: Readonly<Record<FormatId, CreativeFormat>> = {
  feed_portrait: {
    id: "feed_portrait",
    width: 1080,
    height: 1350,
    safe: even(72),
  },
  square: { id: "square", width: 1080, height: 1080, safe: even(72) },
  story: {
    id: "story",
    width: 1080,
    height: 1920,
    safe: { top: 250, right: 72, bottom: 340, left: 72 },
  },
  landscape: { id: "landscape", width: 1200, height: 630, safe: even(48) },
};
/** Formats produced per channel identifier when a project sets no override. */
export const DEFAULT_CHANNEL_FORMATS: Readonly<
  Record<string, readonly FormatId[]>
> = {
  instagram: ["feed_portrait"],
  "instagram-standalone": ["feed_portrait"],
  facebook: ["feed_portrait"],
  linkedin: ["landscape"],
  x: ["landscape"],
  telegram: ["landscape"],
};
/**
 * Formats for a channel: an override replaces the default for its identifier;
 * unknown or missing channels get `square`. Always returns a fresh array.
 */
export function formatsForChannel(
  identifier: string | null,
  overrides?: Readonly<Record<string, readonly FormatId[]>>,
): FormatId[] {
  const lookup = (map: Readonly<Record<string, readonly FormatId[]>>) =>
    identifier !== null && Object.hasOwn(map, identifier)
      ? map[identifier]
      : undefined;
  const found = lookup(overrides ?? {}) ?? lookup(DEFAULT_CHANNEL_FORMATS);
  return [...(found ?? ["square"])];
}
