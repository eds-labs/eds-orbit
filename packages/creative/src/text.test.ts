import { describe, expect, it } from "vitest";
import {
  escapeMarkup,
  fitText,
  type FittedText,
  type TextStyle,
} from "./text.ts";

const style: TextStyle = {
  font: "Inter",
  weight: 700,
  color: "#101828",
  maxSize: 92,
  minSize: 48,
  lineHeight: 1.12,
  align: "left",
  uppercase: false,
  maxLines: 3,
};
const box = { width: 900, height: 360 };

/** Leftmost opaque column in the bottom third of the block (its last line). */
async function lastLineInkStart(fitted: FittedText) {
  const { default: sharp } = await import("sharp");
  const { data, info } = await sharp(fitted.png)
    .raw()
    .toBuffer({ resolveWithObject: true });
  let first = info.width;
  for (let y = Math.floor((info.height * 2) / 3); y < info.height; y++)
    for (let x = 0; x < first; x++)
      if (data[(y * info.width + x) * info.channels + 3]! > 128) {
        first = x;
        break;
      }
  return first;
}

describe("fitText", () => {
  it("fits a short headline at the maximum size", async () => {
    const fitted = await fitText("Plan your week", box, style);
    expect(fitted.size).toBe(92);
    expect(fitted.width).toBeLessThanOrEqual(900);
    expect(fitted.png.length).toBeGreaterThan(0);
  });

  it("shrinks a longer headline within its range", async () => {
    const headline =
      "One shared calendar keeps the whole family on the same page every week";
    expect(headline).toHaveLength(70);
    const fitted = await fitText(headline, box, style);
    expect(fitted.size).toBeGreaterThanOrEqual(48);
    expect(fitted.size).toBeLessThan(92);
    expect(fitted.height).toBeLessThanOrEqual(360);
    expect(fitted.width).toBeLessThanOrEqual(900);
  });

  it("refuses text that cannot fit", async () => {
    const text = "Lorem ipsum dolor sit amet ".repeat(11).trim().slice(0, 290);
    expect(text).toHaveLength(290);
    await expect(fitText(text, box, style)).rejects.toMatchObject({
      code: "TEXT_OVERFLOW",
    });
  });

  it("never draws a compound word outside its box", async () => {
    const outcome = await fitText(
      "Familienkalenderorganisationsassistent",
      { width: 500, height: 360 },
      style,
    ).then(
      (fitted) => ({ fitted }),
      (error: unknown) => ({ error }),
    );
    if ("fitted" in outcome) {
      expect(outcome.fitted.width).toBeLessThanOrEqual(500);
    } else {
      expect(outcome.error).toMatchObject({ code: "TEXT_OVERFLOW" });
    }
  });

  it("renders emoji and accented text", async () => {
    const fitted = await fitText("Plan your week 🎉 — Ça marche", box, style);
    expect(fitted.width).toBeGreaterThan(0);
    expect(fitted.width).toBeLessThanOrEqual(900);
  });

  it("escapes markup", async () => {
    await expect(fitText("<b>x</b> & y", box, style)).resolves.toMatchObject({
      size: 92,
    });
    expect(escapeMarkup("<b>x</b> & y")).toBe("&lt;b&gt;x&lt;/b&gt; &amp; y");
  });

  it("is deterministic", async () => {
    const text = "One shared calendar keeps the whole family on the same page";
    const a = await fitText(text, box, style);
    const b = await fitText(text, box, style);
    expect({ width: a.width, height: a.height, size: a.size }).toEqual({
      width: b.width,
      height: b.height,
      size: b.size,
    });
  });

  it("rejects empty, overlong and control-character text", async () => {
    for (const text of ["   ", "x".repeat(301), "bad\u0000text", "a\nb"]) {
      await expect(fitText(text, box, style)).rejects.toMatchObject({
        code: "INVALID_TEMPLATE_INPUT",
      });
    }
  });

  it("applies uppercase before measuring", async () => {
    const plain = await fitText("Plan your week", box, style);
    const upper = await fitText("Plan your week", box, {
      ...style,
      uppercase: true,
    });
    expect(upper.width).toBeGreaterThan(plain.width);
  });

  it("centres the lines of a block when asked", async () => {
    const text = "Plan your week together";
    const two = { ...style, maxLines: 2 };
    const left = await fitText(text, box, two);
    const centred = await fitText(text, box, { ...two, align: "center" });
    expect(centred.size).toBe(left.size);
    expect(centred.height).toBe(left.height);
    // The shorter last line starts at the left edge when left-aligned and further in when centred.
    const leftEdge = await lastLineInkStart(left);
    const centredEdge = await lastLineInkStart(centred);
    expect(centredEdge).toBeGreaterThan(leftEdge + 20);
  });

  it("only draws integer sizes for fractional size limits", async () => {
    const fitted = await fitText("Plan your week", box, {
      ...style,
      maxSize: 91.8,
      minSize: 47.2,
    });
    expect(Number.isInteger(fitted.size)).toBe(true);
    expect(fitted.size).toBe(91);
    // No integer size lies between the limits.
    await expect(
      fitText("Plan your week", box, {
        ...style,
        maxSize: 47.5,
        minSize: 47.2,
      }),
    ).rejects.toMatchObject({ code: "TEXT_OVERFLOW" });
  });

  it("keeps accented and emoji single lines inside maxLines 1", async () => {
    const oneLine = { ...style, maxLines: 1 };
    for (const text of ["Ça marche Épée Ågård", "Plan 🎉 week"]) {
      const fitted = await fitText(text, box, oneLine);
      expect(fitted.width).toBeLessThanOrEqual(900);
      expect(fitted.size).toBeGreaterThanOrEqual(48);
      expect(fitted.height).toBeLessThan(fitted.size * 1.6);
    }
  });

  it("shrinks to one line or refuses when maxLines is 1", async () => {
    const wraps = "Plan your week together";
    const two = await fitText(wraps, box, { ...style, maxLines: 2 });
    expect(two.size).toBe(92);
    expect(two.height).toBeGreaterThan(two.size * 1.6);
    const one = await fitText(wraps, box, { ...style, maxLines: 1 });
    expect(one.size).toBeLessThan(92);
    expect(one.height).toBeLessThan(one.size * 1.6);
    const long = "One shared calendar keeps the whole family on one page";
    await expect(
      fitText(long, box, { ...style, maxLines: 1 }),
    ).rejects.toMatchObject({ code: "TEXT_OVERFLOW" });
    await expect(fitText(long, box, style)).resolves.toBeDefined();
  });

  it("honours the requested line height on top of the natural pitch", async () => {
    const fixed = { ...style, maxSize: 60, minSize: 60, maxLines: 3 };
    const narrow = { width: 110, height: 360 };
    // "Hg Hg" wraps into two identical lines in a narrow box, one "Hg" is a single line.
    const single = await fitText("Hg", narrow, fixed);
    for (const lineHeight of [0.9, 1, 1.25, 1.5]) {
      const double = await fitText("Hg Hg", narrow, { ...fixed, lineHeight });
      expect(double.size).toBe(60);
      // The second line adds one pitch of size * lineHeight (spacing is rounded to pixels).
      expect(
        Math.abs(double.height - single.height - 60 * lineHeight),
      ).toBeLessThanOrEqual(3);
    }
  });

  it("fits or refuses Cyrillic and CJK text, never drawing outside the box", async () => {
    await expect(
      fitText("Планируйте неделю вместе", box, style),
    ).resolves.toMatchObject({ width: expect.any(Number) });
    for (const text of [
      "Планируйте неделю вместе",
      "家族のカレンダーを一つにまとめる",
    ]) {
      const outcome = await fitText(text, box, style).then(
        (fitted) => ({ fitted }),
        (error: unknown) => ({ error }),
      );
      if ("fitted" in outcome) {
        expect(outcome.fitted.width).toBeLessThanOrEqual(900);
        expect(outcome.fitted.height).toBeLessThanOrEqual(360);
      } else expect(outcome.error).toMatchObject({ code: "TEXT_OVERFLOW" });
    }
  });

  it("accepts a fractional box width without exceeding it", async () => {
    const fitted = await fitText(
      "Plan your week",
      { width: 900.5, height: 360 },
      style,
    );
    expect(fitted.width).toBeLessThanOrEqual(900);
  });

  it("keeps emoji joiners and variation selectors renderable", async () => {
    for (const text of [
      "Family 👨\u200d👩\u200d👧 plan",
      "Love \u2764\ufe0f week",
    ])
      await expect(fitText(text, box, style)).resolves.toBeDefined();
  });

  it("rejects line separators, bidi overrides and C1 controls", async () => {
    for (const bad of [
      "\u0085",
      "\u2028",
      "\u2029",
      "\u202e",
      "\u2066",
      "\u2069",
    ])
      await expect(fitText(`a${bad}b`, box, style)).rejects.toMatchObject({
        code: "INVALID_TEMPLATE_INPUT",
      });
  });

  it("rejects style values that would reach Pango as raw markup or errors", async () => {
    const code = (patch: object, text = "Plan your week") =>
      fitText(text, box, { ...style, ...patch } as TextStyle);
    await expect(code({ font: 'Inter" x="' })).rejects.toMatchObject({
      code: "INVALID_BRAND_FONT",
    });
    await expect(code({ font: "Comic Sans" })).rejects.toMatchObject({
      code: "INVALID_BRAND_FONT",
    });
    for (const color of ["red", "#12345", '#101828" x="1'])
      await expect(code({ color })).rejects.toMatchObject({
        code: "INVALID_BRAND_COLOR",
      });
    for (const patch of [
      { weight: 500 },
      { align: "right" },
      { lineHeight: Number.NaN },
      { lineHeight: 0 },
      { maxLines: Number.NaN },
      { maxLines: 0 },
      { maxLines: 1.5 },
      { maxSize: Number.POSITIVE_INFINITY },
      { minSize: 0 },
      { minSize: 100, maxSize: 50 },
    ])
      await expect(code(patch)).rejects.toMatchObject({
        code: "INVALID_TEMPLATE_INPUT",
      });
    for (const width of [0, 0.5, Number.NaN, 2_000_000])
      await expect(
        fitText("Plan your week", { width, height: 360 }, style),
      ).rejects.toMatchObject({ code: "INVALID_TEMPLATE_INPUT" });
  });
});
