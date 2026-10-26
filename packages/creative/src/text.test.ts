import { describe, expect, it } from "vitest";
import { escapeMarkup, fitText, type TextStyle } from "./text.ts";

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

  it("centers text when asked", async () => {
    const fitted = await fitText("Plan your week", box, {
      ...style,
      align: "center",
    });
    expect(fitted.width).toBeLessThanOrEqual(900);
  });
});
