import { describe, expect, it } from "vitest";
import { CreativeError } from "./errors.ts";
import { CREATIVE_FORMATS, type CreativeFormat } from "./formats.ts";
import {
  CREATIVE_FORMAT_IDS,
  CREATIVE_TEMPLATE_IDS,
  LOGO_PLACEMENTS,
  TEXT_SCALES,
  type FormatId,
  type LogoPlacement,
  type TemplateId,
  type VariantId,
} from "./ids.ts";
import {
  TEMPLATE_COPY_LIMITS,
  TEMPLATE_NEEDS,
  TEMPLATE_VARIANTS,
  artZones,
  layoutFor,
  variantsFor,
  type Box,
  type LayoutSpec,
} from "./templates.ts";

const CORNERS = LOGO_PLACEMENTS.filter((p) => p !== "auto");
const SIDE_VARIANTS: VariantId[] = [
  "text_side",
  "product_left",
  "product_right",
];

/** Every template × format × valid variant, as the engine will request them. */
function allCases() {
  const cases: {
    template: TemplateId;
    variant: VariantId;
    format: FormatId;
  }[] = [];
  for (const template of CREATIVE_TEMPLATE_IDS)
    for (const format of CREATIVE_FORMAT_IDS)
      for (const variant of variantsFor(template, format))
        cases.push({ template, variant, format });
  return cases;
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** Separation of two boxes along their widest free axis (negative when they overlap). */
const gapBetween = (a: Box, b: Box) =>
  Math.max(
    b.x - (a.x + a.w),
    a.x - (b.x + b.w),
    b.y - (a.y + a.h),
    a.y - (b.y + b.h),
  );
const insideSafe = (box: Box, format: CreativeFormat) =>
  box.w > 0 &&
  box.h > 0 &&
  box.x >= format.safe.left &&
  box.y >= format.safe.top &&
  box.x + box.w <= format.width - format.safe.right &&
  box.y + box.h <= format.height - format.safe.bottom;
const insideCanvas = (box: Box, format: CreativeFormat) =>
  box.w > 0 &&
  box.h > 0 &&
  box.x >= 0 &&
  box.y >= 0 &&
  box.x + box.w <= format.width &&
  box.y + box.h <= format.height;
const asFractions = (box: Box, format: CreativeFormat): Box => ({
  x: box.x / format.width,
  y: box.y / format.height,
  w: box.w / format.width,
  h: box.h / format.height,
});
const options = (logoPlacement: LogoPlacement = "auto") =>
  ({ logoPlacement, textScale: "m" }) as const;

/** Logo, text and product never overlap, and the logo keeps its clear space. */
function expectNoOverlaps(layout: LayoutSpec) {
  const clearance = Math.round(0.025 * layout.format.width);
  expect(overlaps(layout.logo.box, layout.textBox)).toBe(false);
  expect(gapBetween(layout.logo.box, layout.textBox)).toBeGreaterThanOrEqual(
    clearance,
  );
  if (layout.product) {
    expect(overlaps(layout.product, layout.textBox)).toBe(false);
    expect(overlaps(layout.product, layout.logo.box)).toBe(false);
    expect(gapBetween(layout.logo.box, layout.product)).toBeGreaterThanOrEqual(
      clearance,
    );
    // A visible gutter between the text and the product frame.
    expect(gapBetween(layout.product, layout.textBox)).toBeGreaterThanOrEqual(
      Math.round(0.012 * layout.format.width),
    );
  }
}

describe("template tables", () => {
  it("covers all seven templates in every table", () => {
    const ids = [...CREATIVE_TEMPLATE_IDS].sort();
    expect(ids).toHaveLength(7);
    expect(Object.keys(TEMPLATE_VARIANTS).sort()).toEqual(ids);
    expect(Object.keys(TEMPLATE_NEEDS).sort()).toEqual(ids);
    expect(Object.keys(TEMPLATE_COPY_LIMITS).sort()).toEqual(ids);
    for (const template of CREATIVE_TEMPLATE_IDS) {
      // Every declared variant has a layout on the roomiest format.
      for (const variant of TEMPLATE_VARIANTS[template])
        expect(() =>
          layoutFor(template, variant, "square", options()),
        ).not.toThrow();
    }
  });

  it("lists the variants, the first being the default", () => {
    expect(TEMPLATE_VARIANTS).toEqual({
      product_showcase: ["product_right", "product_left", "text_top"],
      feature_highlight: ["text_top", "product_left", "product_right"],
      problem_solution: ["text_top", "text_bottom"],
      lifestyle: ["text_bottom", "text_top", "text_side"],
      tips: ["text_top", "centered"],
      announcement: ["centered", "text_bottom"],
      brand_message: ["centered", "text_bottom"],
    });
  });

  it("states which assets each template needs", () => {
    expect(TEMPLATE_NEEDS).toEqual({
      product_showcase: { art: "optional", product: "required" },
      feature_highlight: { art: "optional", product: "required" },
      problem_solution: { art: "required", product: "optional" },
      lifestyle: { art: "required", product: "none" },
      tips: { art: "optional", product: "none" },
      announcement: { art: "optional", product: "optional" },
      brand_message: { art: "required", product: "none" },
    });
  });

  it("limits copy per template", () => {
    for (const template of CREATIVE_TEMPLATE_IDS) {
      const wide = template === "tips" || template === "brand_message";
      expect(TEMPLATE_COPY_LIMITS[template]).toEqual({
        eyebrow: 32,
        headline: wide ? 70 : 60,
        subline: template === "tips" ? 180 : 120,
        cta: 24,
      });
    }
  });
});

describe("variantsFor", () => {
  it("keeps the declared order on landscape and square", () => {
    for (const format of ["landscape", "square"] as const)
      for (const template of CREATIVE_TEMPLATE_IDS)
        expect(variantsFor(template, format)).toEqual(
          TEMPLATE_VARIANTS[template],
        );
  });

  it("drops side variants on portrait formats", () => {
    for (const format of ["feed_portrait", "story"] as const)
      for (const template of CREATIVE_TEMPLATE_IDS) {
        const variants = variantsFor(template, format);
        expect(variants.length).toBeGreaterThan(0);
        for (const side of SIDE_VARIANTS) expect(variants).not.toContain(side);
      }
    expect(variantsFor("lifestyle", "story")).toEqual([
      "text_bottom",
      "text_top",
    ]);
    expect(variantsFor("product_showcase", "feed_portrait")).toEqual([
      "text_top",
    ]);
  });

  it("returns a fresh array", () => {
    const first = variantsFor("tips", "square");
    first.push("text_side");
    expect(variantsFor("tips", "square")).toEqual(["text_top", "centered"]);
    expect(TEMPLATE_VARIANTS.tips).toEqual(["text_top", "centered"]);
  });

  it("rejects unknown templates and formats", () => {
    expect(() => variantsFor("constructor" as TemplateId, "square")).toThrow(
      expect.objectContaining({ code: "INVALID_TEMPLATE_INPUT" }),
    );
    expect(() => variantsFor("tips", "__proto__" as FormatId)).toThrow(
      expect.objectContaining({ code: "INVALID_TEMPLATE_INPUT" }),
    );
  });
});

describe("layoutFor", () => {
  it("lays out every template, variant and format inside the safe area", () => {
    const cases = allCases();
    // 17 variants on landscape and square, the 12 non-side ones on the two portrait formats.
    expect(cases).toHaveLength(2 * 17 + 2 * 12);
    for (const { template, variant, format: formatId } of cases) {
      const format = CREATIVE_FORMATS[formatId];
      for (const textScale of TEXT_SCALES) {
        const layout = layoutFor(template, variant, formatId, {
          logoPlacement: "auto",
          textScale,
        });
        const label = `${template}/${variant}/${formatId}`;
        expect(layout.format, label).toEqual(format);
        expect(insideSafe(layout.textBox, format), label).toBe(true);
        expect(insideSafe(layout.logo.box, format), label).toBe(true);
        expect(CORNERS, label).toContain(layout.logo.corner);
        expectNoOverlaps(layout);
        // A product box exists exactly when the template can carry a product.
        expect(layout.product !== null, label).toBe(
          TEMPLATE_NEEDS[template].product !== "none",
        );
        if (layout.product)
          expect(insideSafe(layout.product, format), label).toBe(true);

        const zones = layout.reservedZones;
        expect(zones, label).toHaveLength(layout.product ? 3 : 2);
        const expected = [layout.textBox, layout.logo.box, layout.product]
          .filter((box): box is Box => box !== null)
          .map((box) => asFractions(box, format));
        zones.forEach((zone, i) => {
          for (const key of ["x", "y", "w", "h"] as const)
            expect(zone[key], label).toBeCloseTo(expected[i]![key], 9);
          expect(zone.x, label).toBeGreaterThanOrEqual(0);
          expect(zone.x + zone.w, label).toBeLessThanOrEqual(1);
          expect(zone.y + zone.h, label).toBeLessThanOrEqual(1);
        });
      }
    }
  });

  it("lets auto take the first corner, in a fixed order, that shrinks nothing", () => {
    // Independent of ids.ts: the order the brief fixes.
    const order = [
      "top_left",
      "top_right",
      "bottom_left",
      "bottom_right",
    ] as const;
    const area = (box: Box | null) => (box ? box.w * box.h : 0);
    for (const { template, variant, format } of allCases()) {
      const label = `${template}/${variant}/${format}`;
      const auto = layoutFor(template, variant, format, options());
      const explicit = order.map((corner) =>
        layoutFor(template, variant, format, options(corner)),
      );
      // A box is shrunk when it is smaller than in the best corner for it.
      const roomText = Math.max(...explicit.map((l) => area(l.textBox)));
      const roomProduct = Math.max(...explicit.map((l) => area(l.product)));
      const shrinks = (l: LayoutSpec) =>
        area(l.textBox) < roomText || area(l.product) < roomProduct;
      const firstFree = order.find((_, i) => !shrinks(explicit[i]!));
      // Every layout leaves at least one corner that needs no shrinking.
      expect(firstFree, label).toBeDefined();
      expect(auto.logo.corner, label).toBe(firstFree);
      expect(area(auto.textBox), label).toBe(roomText);
      expect(area(auto.product), label).toBe(roomProduct);
    }
  });

  it("picks the expected automatic corner where earlier corners are blocked", () => {
    const corner = (t: TemplateId, v: VariantId, f: FormatId) =>
      layoutFor(t, v, f, options()).logo.corner;
    expect(corner("lifestyle", "text_bottom", "square")).toBe("top_left");
    // The product column blocks top_left; the band above the text is free.
    expect(corner("feature_highlight", "product_left", "landscape")).toBe(
      "top_right",
    );
    expect(corner("feature_highlight", "product_left", "square")).toBe(
      "top_right",
    );
    // Text at the top blocks both top corners.
    expect(corner("lifestyle", "text_top", "feed_portrait")).toBe(
      "bottom_left",
    );
    // A full-height text column and a product at the top leave the corner under the product.
    expect(corner("product_showcase", "product_right", "landscape")).toBe(
      "bottom_right",
    );
    expect(corner("product_showcase", "product_left", "landscape")).toBe(
      "bottom_left",
    );
  });

  it("gives the default landscape layout of every template room for four text layers", () => {
    // R12/R14: on landscape the first side variant is the default, else the first variant.
    const side = new Set<VariantId>(SIDE_VARIANTS);
    for (const template of CREATIVE_TEMPLATE_IDS) {
      const offered = variantsFor(template, "landscape");
      const chosen = offered.find((v) => side.has(v)) ?? offered[0]!;
      const layout = layoutFor(template, chosen, "landscape", options());
      // Eyebrow, headline, subline and CTA at minimum size measure about 342 px.
      expect(layout.textBox.h, `${template}/${chosen}`).toBeGreaterThanOrEqual(
        342,
      );
    }
    // Both stacked variants of problem_solution are roomy enough too.
    for (const variant of TEMPLATE_VARIANTS.problem_solution)
      expect(
        layoutFor("problem_solution", variant, "landscape", options()).textBox
          .h,
      ).toBeGreaterThanOrEqual(342);
  });

  it("refuses side variants on portrait formats", () => {
    expect(() =>
      layoutFor("lifestyle", "text_side", "story", options()),
    ).toThrow(expect.objectContaining({ code: "INVALID_TEMPLATE_VARIANT" }));
    expect(() =>
      layoutFor(
        "feature_highlight",
        "product_left",
        "feed_portrait",
        options(),
      ),
    ).toThrow(CreativeError);
    expect(() =>
      layoutFor(
        "product_showcase",
        "product_right",
        "feed_portrait",
        options(),
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_TEMPLATE_VARIANT" }));
    // The same variants are fine on the formats that allow them.
    expect(() =>
      layoutFor("lifestyle", "text_side", "landscape", options()),
    ).not.toThrow();
  });

  it("refuses a variant the template does not offer", () => {
    expect(() => layoutFor("tips", "text_side", "square", options())).toThrow(
      expect.objectContaining({ code: "INVALID_TEMPLATE_VARIANT" }),
    );
    expect(() =>
      layoutFor("brand_message", "product_left", "landscape", options()),
    ).toThrow(expect.objectContaining({ code: "INVALID_TEMPLATE_VARIANT" }));
  });

  it("rejects unknown ids and options", () => {
    const code = { code: "INVALID_TEMPLATE_INPUT" };
    expect(() =>
      layoutFor("toString" as TemplateId, "centered", "square", options()),
    ).toThrow(expect.objectContaining(code));
    expect(() =>
      layoutFor("tips", "centered", "wide" as FormatId, options()),
    ).toThrow(expect.objectContaining(code));
    expect(() =>
      layoutFor("tips", "centered", "square", {
        logoPlacement: "middle" as LogoPlacement,
        textScale: "m",
      }),
    ).toThrow(expect.objectContaining(code));
    expect(() =>
      layoutFor("tips", "centered", "square", {
        logoPlacement: "auto",
        textScale: "xl" as "m",
      }),
    ).toThrow(expect.objectContaining(code));
  });

  it("anchors an explicit logo corner", () => {
    for (const formatId of CREATIVE_FORMAT_IDS) {
      const { width: W, height: H, safe } = CREATIVE_FORMATS[formatId];
      const [variant] = variantsFor("lifestyle", formatId);
      const at = (corner: LogoPlacement) =>
        layoutFor("lifestyle", variant!, formatId, options(corner)).logo;
      const br = at("bottom_right");
      expect(br.corner).toBe("bottom_right");
      expect(br.box.x + br.box.w).toBe(W - safe.right);
      expect(br.box.y + br.box.h).toBe(H - safe.bottom);
      const tl = at("top_left");
      expect(tl.box.x).toBe(safe.left);
      expect(tl.box.y).toBe(safe.top);
      const tr = at("top_right");
      expect(tr.box.x + tr.box.w).toBe(W - safe.right);
      expect(tr.box.y).toBe(safe.top);
      const bl = at("bottom_left");
      expect(bl.box.x).toBe(safe.left);
      expect(bl.box.y + bl.box.h).toBe(H - safe.bottom);
      // 0.2·W (landscape 0.14·W, T20) × max(0.06·H, 0.05·W) (R19), whichever corner.
      for (const logo of [br, tl, tr, bl]) {
        expect(logo.box.w).toBe(
          Math.round((formatId === "landscape" ? 0.14 : 0.2) * W),
        );
        expect(logo.box.h).toBe(Math.round(Math.max(0.06 * H, 0.05 * W)));
      }
    }
    // Landscape gets 60 px instead of 38 px; the tall formats keep 0.06·H.
    expect(
      layoutFor("lifestyle", "text_side", "landscape", options()).logo.box.h,
    ).toBe(60);
    expect(
      layoutFor("lifestyle", "text_bottom", "feed_portrait", options()).logo.box
        .h,
    ).toBe(81);
  });

  it("makes the logo box of a mark narrower", () => {
    const wide = layoutFor("lifestyle", "text_bottom", "square", options());
    const mark = layoutFor("lifestyle", "text_bottom", "square", {
      ...options(),
      logoRole: "mark",
    });
    expect(wide.logo.box.w).toBe(Math.round(0.2 * 1080));
    expect(mark.logo.box.w).toBe(Math.round(0.1 * 1080));
    expect(mark.logo.box.h).toBe(wide.logo.box.h);
  });

  it("never lets an explicit logo corner touch the text or the product", () => {
    let shrunk = 0;
    for (const { template, variant, format: formatId } of allCases()) {
      const format = CREATIVE_FORMATS[formatId];
      const auto = layoutFor(template, variant, formatId, options());
      for (const corner of CORNERS) {
        const layout = layoutFor(template, variant, formatId, options(corner));
        const label = `${template}/${variant}/${formatId}/${corner}`;
        expect(layout.logo.corner, label).toBe(corner);
        expect(insideSafe(layout.logo.box, format), label).toBe(true);
        expect(insideSafe(layout.textBox, format), label).toBe(true);
        if (layout.product)
          expect(insideSafe(layout.product, format), label).toBe(true);
        expectNoOverlaps(layout);
        // The text box only ever shrinks, away from the logo band.
        expect(layout.textBox.h, label).toBeLessThanOrEqual(auto.textBox.h);
        expect(layout.textBox.w, label).toBe(auto.textBox.w);
        if (layout.textBox.h < auto.textBox.h) {
          shrunk += 1;
          if (corner.startsWith("top")) {
            expect(layout.textBox.y, label).toBeGreaterThanOrEqual(
              layout.logo.box.y + layout.logo.box.h,
            );
            expect(layout.textBox.y + layout.textBox.h, label).toBe(
              auto.textBox.y + auto.textBox.h,
            );
          } else {
            expect(layout.textBox.y, label).toBe(auto.textBox.y);
            expect(
              layout.textBox.y + layout.textBox.h,
              label,
            ).toBeLessThanOrEqual(layout.logo.box.y);
          }
        }
        // The zones stay in step with the final boxes.
        const [text, logo] = layout.reservedZones;
        expect(text!.h, label).toBeCloseTo(layout.textBox.h / format.height, 9);
        expect(logo!.y, label).toBeCloseTo(
          layout.logo.box.y / format.height,
          9,
        );
      }
    }
    // The shrinking path is exercised, not vacuously skipped.
    expect(shrunk).toBeGreaterThan(20);
  });

  it("shrinks the text away from a logo placed in the text band", () => {
    const auto = layoutFor("lifestyle", "text_top", "feed_portrait", options());
    expect(auto.logo.corner).toBe("bottom_left");
    const top = layoutFor(
      "lifestyle",
      "text_top",
      "feed_portrait",
      options("top_left"),
    );
    expect(top.textBox.y).toBeGreaterThan(auto.textBox.y);
    expect(top.textBox.y).toBeGreaterThanOrEqual(
      top.logo.box.y + top.logo.box.h,
    );
    expect(top.textBox.y + top.textBox.h).toBe(auto.textBox.y + auto.textBox.h);
  });

  it("scales text maxima, not minima", () => {
    const sizes = (textScale: "s" | "m" | "l") =>
      layoutFor("announcement", "centered", "feed_portrait", {
        logoPlacement: "auto",
        textScale,
      }).sizes;
    const [s, m, l] = [sizes("s"), sizes("m"), sizes("l")];
    for (const kind of ["eyebrow", "headline", "subline", "cta"] as const) {
      expect(l[kind].max, kind).toBeGreaterThan(m[kind].max);
      expect(m[kind].max, kind).toBeGreaterThan(s[kind].max);
      expect(l[kind].min, kind).toBe(m[kind].min);
      expect(s[kind].min, kind).toBe(m[kind].min);
      expect(s[kind].max, kind).toBeGreaterThanOrEqual(s[kind].min);
    }
  });

  it("derives text sizes from the format width", () => {
    const m = (id: FormatId) =>
      layoutFor("lifestyle", "text_bottom", id, options()).sizes;
    const square = m("square");
    expect(square.headline).toEqual({ max: 92, min: 49 });
    expect(square.subline).toEqual({ max: 43, min: 30 });
    expect(square.eyebrow).toEqual({ max: 30, min: 24 });
    expect(square.cta).toEqual({ max: 35, min: 28 });
    // Landscape: smaller headline maximum (0.06·W of 1200), same ratios otherwise.
    const landscape = m("landscape");
    expect(landscape.headline).toEqual({ max: 72, min: 54 });
    expect(landscape.subline).toEqual({ max: 48, min: 34 });
    expect(landscape.eyebrow).toEqual({ max: 34, min: 26 });
    expect(landscape.cta).toEqual({ max: 38, min: 31 });
    // The scale multiplies the maximum only.
    const large = layoutFor("lifestyle", "text_bottom", "square", {
      logoPlacement: "auto",
      textScale: "l",
    }).sizes;
    expect(large.headline).toEqual({ max: 106, min: 49 });
    const small = layoutFor("lifestyle", "text_bottom", "square", {
      logoPlacement: "auto",
      textScale: "s",
    }).sizes;
    expect(small.headline).toEqual({ max: 78, min: 49 });
  });

  it("aligns centred variants to the centre and the rest to the left", () => {
    for (const { template, variant, format } of allCases()) {
      const layout = layoutFor(template, variant, format, options());
      expect(layout.textAlign, `${template}/${variant}`).toBe(
        variant === "centered" ? "center" : "left",
      );
      expect(layout.stack).toEqual(["eyebrow", "headline", "subline", "cta"]);
    }
  });

  it("describes the background, art and scrim of each template", () => {
    for (const { template, variant, format: formatId } of allCases()) {
      const format = CREATIVE_FORMATS[formatId];
      const layout = layoutFor(template, variant, formatId, options());
      const label = `${template}/${variant}/${formatId}`;
      const needs = TEMPLATE_NEEDS[template];
      // Required art is the whole canvas; templates on a brand field place it apart.
      if (layout.background === "art")
        expect(layout.art, label).toEqual({
          x: 0,
          y: 0,
          w: format.width,
          h: format.height,
        });
      expect(layout.background === "art", label).toBe(needs.art === "required");
      expect(layout.art, label).not.toBeNull();
      expect(insideCanvas(layout.art!, format), label).toBe(true);
      if (template === "feature_highlight" || template === "tips") {
        // Text sits on the plain brand field, away from the art.
        expect(layout.background, label).toBe("brand");
        expect(layout.scrim, label).toBeNull();
        expect(overlaps(layout.art!, layout.textBox), label).toBe(false);
        expect(
          gapBetween(layout.art!, layout.textBox),
          label,
        ).toBeGreaterThanOrEqual(Math.round(0.015 * format.width));
        // The art is an accent or a backdrop for the product, never most of the canvas.
        expect(layout.art!.w * layout.art!.h, label).toBeLessThan(
          format.width * format.height * (template === "tips" ? 0.4 : 0.6),
        );
        if (layout.product)
          expect(overlaps(layout.art!, layout.product), label).toBe(true);
      } else {
        const scrim = layout.scrim!;
        expect(scrim, label).not.toBeNull();
        expect(insideCanvas(scrim.box, format), label).toBe(true);
        expect(scrim.base, label).toBeGreaterThanOrEqual(0);
        expect(scrim.base, label).toBeLessThan(scrim.max);
        expect(scrim.max, label).toBeLessThanOrEqual(1);
        // The scrim covers the text and leaves a product untouched.
        expect(
          scrim.box.x <= layout.textBox.x &&
            scrim.box.y <= layout.textBox.y &&
            scrim.box.x + scrim.box.w >= layout.textBox.x + layout.textBox.w &&
            scrim.box.y + scrim.box.h >= layout.textBox.y + layout.textBox.h,
          label,
        ).toBe(true);
        if (layout.product)
          expect(overlaps(scrim.box, layout.product), label).toBe(false);
        expect(["up", "down", "left", "right", "full"], label).toContain(
          scrim.direction,
        );
      }
    }
    // Text at the bottom fades up, text at the top fades down, a statement tints everything.
    const dir = (t: TemplateId, v: VariantId) =>
      layoutFor(t, v, "square", options()).scrim?.direction;
    expect(dir("lifestyle", "text_bottom")).toBe("up");
    expect(dir("lifestyle", "text_top")).toBe("down");
    expect(dir("lifestyle", "text_side")).toBe("right");
    expect(dir("brand_message", "centered")).toBe("full");
    expect(dir("product_showcase", "product_right")).toBe("right");
    expect(dir("product_showcase", "product_left")).toBe("left");
    // Strong scrim for announcements.
    expect(
      layoutFor("announcement", "centered", "square", options()).scrim!.base,
    ).toBeGreaterThan(
      layoutFor("lifestyle", "text_bottom", "square", options()).scrim!.base,
    );
  });

  it("is pure: equal calls give equal layouts that share no objects", () => {
    const a = layoutFor("announcement", "centered", "story", options());
    const b = layoutFor("announcement", "centered", "story", options());
    expect(a).toEqual(b);
    a.textBox.x = -1;
    a.format.safe.top = -1;
    a.stack.pop();
    a.reservedZones[0]!.w = 9;
    expect(CREATIVE_FORMATS.story.safe.top).toBe(250);
    expect(layoutFor("announcement", "centered", "story", options())).toEqual(
      b,
    );
  });
});

describe("artZones", () => {
  it("gives the reserved zones in the frame of the drawn art (R21)", () => {
    for (const { template, variant, format: formatId } of allCases()) {
      const layout = layoutFor(template, variant, formatId, options());
      const { width: W, height: H } = layout.format;
      const art = layout.art!;
      const label = `${template}/${variant}/${formatId}`;
      // Every canvas zone, clipped to the art box, in pixels.
      const expected = layout.reservedZones.flatMap((zone) => {
        const x0 = Math.max(zone.x * W, art.x);
        const y0 = Math.max(zone.y * H, art.y);
        const x1 = Math.min((zone.x + zone.w) * W, art.x + art.w);
        const y1 = Math.min((zone.y + zone.h) * H, art.y + art.h);
        return x1 > x0 && y1 > y0 ? [{ x0, y0, x1, y1 }] : [];
      });
      const zones = artZones(layout);
      expect(zones.length, label).toBe(expected.length);
      zones.forEach((zone, i) => {
        expect(zone.x, label).toBeGreaterThanOrEqual(0);
        expect(zone.y, label).toBeGreaterThanOrEqual(0);
        expect(zone.x + zone.w, label).toBeLessThanOrEqual(1 + 1e-9);
        expect(zone.y + zone.h, label).toBeLessThanOrEqual(1 + 1e-9);
        // Back on the canvas, the zone is the clipped one.
        expect(art.x + zone.x * art.w, label).toBeCloseTo(expected[i]!.x0, 6);
        expect(art.y + zone.y * art.h, label).toBeCloseTo(expected[i]!.y0, 6);
        expect(art.x + (zone.x + zone.w) * art.w, label).toBeCloseTo(
          expected[i]!.x1,
          6,
        );
        expect(art.y + (zone.y + zone.h) * art.h, label).toBeCloseTo(
          expected[i]!.y1,
          6,
        );
      });
    }
  });

  it("maps full-canvas art one to one and drops zones beside an art strip", () => {
    const full = layoutFor(
      "lifestyle",
      "text_bottom",
      "feed_portrait",
      options(),
    );
    expect(artZones(full)).toEqual(full.reservedZones);
    // feature_highlight: the art is a strip at the bottom, behind the product;
    // the text and logo above it are not part of the art.
    const strip = layoutFor(
      "feature_highlight",
      "text_top",
      "feed_portrait",
      options(),
    );
    expect(strip.art!.y).toBeGreaterThan(0);
    const zones = artZones(strip);
    expect(zones).toHaveLength(1);
    const product = strip.product!;
    expect(zones[0]!.y).toBeCloseTo(
      (product.y - strip.art!.y) / strip.art!.h,
      6,
    );
    expect(zones[0]!.x).toBeCloseTo(product.x / strip.art!.w, 6);
  });
});
