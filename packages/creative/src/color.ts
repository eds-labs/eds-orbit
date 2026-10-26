/** A `#RRGGBB` colour or an sRGB triple (0..255). */
export type ColorInput = string | readonly [number, number, number];

/** sRGB channel value (0..255) to linear light, per the sRGB transfer function. */
export const LINEAR_CHANNEL: Float64Array = Float64Array.from(
  { length: 256 },
  (_, value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  },
);

/** Parses `#RRGGBB` into an sRGB triple; anything else is a programming error. */
export function parseHex(color: string): [number, number, number] {
  if (!/^#[0-9A-F]{6}$/i.test(color))
    throw new Error(`invalid colour ${color}`);
  return [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** WCAG 2.x relative luminance (0 black .. 1 white). */
export function relativeLuminance(color: ColorInput): number {
  const [r, g, b] = typeof color === "string" ? parseHex(color) : color;
  return (
    0.2126 * LINEAR_CHANNEL[r]! +
    0.7152 * LINEAR_CHANNEL[g]! +
    0.0722 * LINEAR_CHANNEL[b]!
  );
}

/** WCAG 2.x contrast ratio (1..21); a number is taken as a relative luminance. */
export function contrastRatio(
  a: ColorInput | number,
  b: ColorInput | number,
): number {
  const la = typeof a === "number" ? a : relativeLuminance(a);
  const lb = typeof b === "number" ? b : relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
