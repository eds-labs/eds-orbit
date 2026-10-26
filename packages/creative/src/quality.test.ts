import { describe, expect, it } from "vitest";
import {
  demoBrand,
  fixtureArt,
  fixtureScreenshot,
  type DemoBrandName,
} from "../fixtures/demo-brands.ts";
import { CREATIVE_THRESHOLDS } from "./analysis.ts";
import { relativeLuminance } from "./color.ts";
import {
  composeCreative,
  type ComposeResult,
  type LayerRecord,
} from "./compose.ts";
import { CREATIVE_TEMPLATE_IDS, type TemplateId } from "./ids.ts";
import {
  checkArt,
  checkComposition,
  failedBlockers,
  type CreativeCheck,
  type CreativeCheckCode,
} from "./quality.ts";
import { TEMPLATE_NEEDS, layoutFor, variantsFor } from "./templates.ts";

const COPY = {
  eyebrow: "New this autumn",
  headline: "Evenings feel softer in warm light",
  subline: "Lamps, throws and textures that turn any room into a calm retreat.",
  cta: "Shop the collection",
};
const OPTIONS = { logoPlacement: "auto", textScale: "m" } as const;
const TEXT_KINDS = ["eyebrow", "headline", "subline", "cta"] as const;

const failed = (checks: CreativeCheck[]) =>
  checks.filter((c) => !c.passed).map((c) => c.code);
const find = (checks: CreativeCheck[], code: CreativeCheckCode) => {
  const check = checks.find((c) => c.code === code);
  if (!check) throw new Error(`no ${code} check`);
  return check;
};

/** The approved hashes of a composition's inputs. */
function approvedOf(result: ComposeResult) {
  const of = (kind: LayerRecord["kind"]) =>
    result.layers.filter((l) => l.kind === kind).map((l) => l.sourceSha256!);
  return { logoSha256: of("logo"), productSha256: of("product") };
}

/** A copy of the result whose layers of one kind are changed by `change`. */
function withLayer(
  result: ComposeResult,
  kind: LayerRecord["kind"],
  change: (layer: LayerRecord) => LayerRecord,
): ComposeResult {
  return {
    ...result,
    layers: result.layers.map((l) => (l.kind === kind ? change(l) : l)),
  };
}

/** A creative with art, a screenshot (where the template has room) and the brand's logo. */
async function compose(
  brandName: DemoBrandName,
  template: TemplateId,
  format: "feed_portrait" | "square" = "feed_portrait",
) {
  const art = await fixtureArt("good", brandName);
  const variant = variantsFor(template, format)[0]!;
  const result = await composeCreative({
    template,
    variant,
    format,
    brand: await demoBrand(brandName),
    copy: COPY,
    art,
    products:
      TEMPLATE_NEEDS[template].product === "none"
        ? undefined
        : [await fixtureScreenshot(brandName)],
    options: OPTIONS,
  });
  const { reservedZones } = layoutFor(template, variant, format, OPTIONS);
  return { result, art, reservedZones };
}

describe("checkArt", () => {
  it.each(["lumora", "kestrel"] as const)(
    "flags bad art (%s)",
    async (brand) => {
      const { reservedZones } = layoutFor(
        "lifestyle",
        "text_bottom",
        "feed_portrait",
        OPTIONS,
      );
      const tiny = await checkArt(
        (await fixtureArt("tiny_subject", brand)).bytes,
        reservedZones,
      );
      expect(failed(tiny)).toContain("SUBJECT_TOO_SMALL");
      expect(find(tiny, "SUBJECT_TOO_SMALL").severity).toBe("blocker");

      const flat = await checkArt(
        (await fixtureArt("flat", brand)).bytes,
        reservedZones,
      );
      expect(failed(flat)).toContain("EMPTY_AREA_EXCESSIVE");
      expect(find(flat, "EMPTY_AREA_EXCESSIVE").severity).toBe("blocker");
      expect(failedBlockers(flat)).toContain("EMPTY_AREA_EXCESSIVE");

      const good = await checkArt(
        (await fixtureArt("good", brand)).bytes,
        reservedZones,
      );
      expect(good.map((c) => c.code).sort()).toEqual([
        "EMPTY_AREA_EXCESSIVE",
        "SUBJECT_TOO_SMALL",
      ]);
      expect(failed(good)).toEqual([]);
    },
  );
});

describe("checkComposition", () => {
  it("passes a good composition", async () => {
    const { result } = await compose("lumora", "lifestyle");
    const checks = checkComposition(result, approvedOf(result));
    expect(failed(checks)).toEqual([]);
    expect(failedBlockers(checks)).toEqual([]);
    expect(checks.map((c) => c.code).sort()).toEqual(
      [
        "ASSET_UPSCALED",
        "CREATIVE_DIMENSIONS",
        "CREATIVE_FILE_TOO_LARGE",
        "LAYER_OVERLAP",
        "LOGO_CONTRAST_LOW",
        "LOGO_INTEGRITY",
        "SAFE_AREA_VIOLATION",
        "SCREENSHOT_INTEGRITY",
        "TEXT_BACKDROP_BUSY",
        "TEXT_CONTRAST_LOW",
      ].sort(),
    );
  });

  it("detects tampered or weak results", async () => {
    const { result } = await compose("kestrel", "feature_highlight");
    const approved = approvedOf(result);
    const blockers = (changed: ComposeResult) =>
      failedBlockers(checkComposition(changed, approved));
    expect(blockers(result)).toEqual([]);

    // Logo bytes that were not approved.
    expect(
      failedBlockers(
        checkComposition(result, { ...approved, logoSha256: ["0".repeat(64)] }),
      ),
    ).toEqual(["LOGO_INTEGRITY"]);
    // A screenshot that was not approved.
    expect(
      failedBlockers(
        checkComposition(result, {
          ...approved,
          productSha256: ["f".repeat(64)],
        }),
      ),
    ).toEqual(["SCREENSHOT_INTEGRITY"]);
    // A logo or screenshot whose aspect changed.
    expect(
      blockers(
        withLayer(result, "logo", (l) => ({
          ...l,
          box: { ...l.box, h: l.box.h + 6 },
        })),
      ),
    ).toContain("LOGO_INTEGRITY");
    expect(
      blockers(
        withLayer(result, "product", (l) => ({
          ...l,
          box: { ...l.box, w: l.box.w - 20 },
        })),
      ),
    ).toEqual(["SCREENSHOT_INTEGRITY"]);
    // A logo below the minimum size.
    expect(
      blockers(
        withLayer(result, "logo", (l) => {
          const w = Math.floor(
            (CREATIVE_THRESHOLDS.minLogoWidthShare - 0.01) * result.width,
          );
          return {
            ...l,
            box: {
              ...l.box,
              w,
              h: Math.round((w * l.sourceSize!.height) / l.sourceSize!.width),
            },
          };
        }),
      ),
    ).toEqual(["LOGO_INTEGRITY"]);
    // Backdrops forced to the text colour.
    const textOnItself: ComposeResult = {
      ...result,
      backdrops: { ...result.backdrops },
    };
    for (const layer of result.layers)
      if (TEXT_KINDS.includes(layer.kind as never)) {
        const l = relativeLuminance(layer.color!);
        textOnItself.backdrops[layer.kind as (typeof TEXT_KINDS)[number]] = {
          p10: l,
          p90: l,
          busy: 0,
        };
      }
    expect(blockers(textOnItself)).toEqual(["TEXT_CONTRAST_LOW"]);
    // A busy backdrop behind the headline (R17).
    expect(
      blockers({
        ...result,
        backdrops: {
          ...result.backdrops,
          headline: {
            ...result.backdrops.headline!,
            busy: CREATIVE_THRESHOLDS.busyText + 0.01,
          },
        },
      }),
    ).toEqual(["TEXT_BACKDROP_BUSY"]);
    // The logo on a backdrop of its own colour.
    const ink = relativeLuminance(
      result.layers.find((l) => l.kind === "logo")!.color!,
    );
    expect(
      blockers({
        ...result,
        backdrops: { ...result.backdrops, logo: { p10: ink, p90: ink } },
      }),
    ).toEqual(["LOGO_CONTRAST_LOW"]);
    // A PNG over the size limit.
    const large = Buffer.concat([
      result.png,
      Buffer.alloc(CREATIVE_THRESHOLDS.maxFileBytes + 1 - result.png.length),
    ]);
    expect(large.length).toBe(CREATIVE_THRESHOLDS.maxFileBytes + 1);
    expect(blockers({ ...result, png: large })).toEqual([
      "CREATIVE_FILE_TOO_LARGE",
    ]);
    // Pixels of another size than the format.
    const { default: sharp } = await import("sharp");
    const small = await sharp(result.png).resize(540).png().toBuffer();
    expect(blockers({ ...result, png: small })).toEqual([
      "CREATIVE_DIMENSIONS",
    ]);
    expect(blockers({ ...result, png: Buffer.from("not a png") })).toContain(
      "CREATIVE_DIMENSIONS",
    );
    // A layer outside the safe area, and two layers on top of each other.
    expect(
      blockers(
        withLayer(result, "headline", (l) => ({
          ...l,
          box: { ...l.box, x: 10 },
        })),
      ),
    ).toContain("SAFE_AREA_VIOLATION");
    const product = result.layers.find((l) => l.kind === "product")!;
    expect(
      blockers(
        withLayer(result, "subline", (l) => ({
          ...l,
          box: { ...l.box, y: product.box.y + 4 },
        })),
      ),
    ).toEqual(["LAYER_OVERLAP"]);
    // No logo at all.
    expect(
      blockers({
        ...result,
        layers: result.layers.filter((l) => l.kind !== "logo"),
      }),
    ).toEqual(expect.arrayContaining(["LOGO_INTEGRITY", "LOGO_CONTRAST_LOW"]));
  });

  it("warns on upscaled assets (Review Focus 4)", async () => {
    const brand = await demoBrand("kestrel");
    const small = await fixtureScreenshot("kestrel", {
      width: 400,
      height: 300,
    });
    const result = await composeCreative({
      template: "feature_highlight",
      variant: "text_top",
      format: "feed_portrait",
      brand,
      copy: COPY,
      products: [small],
      options: OPTIONS,
    });
    const product = result.layers.find((l) => l.kind === "product")!;
    expect(product.scale).toBeGreaterThan(CREATIVE_THRESHOLDS.maxUpscale);
    const checks = checkComposition(result, approvedOf(result));
    const upscaled = find(checks, "ASSET_UPSCALED");
    expect(upscaled.passed).toBe(false);
    expect(upscaled.severity).toBe("warning");
    expect(upscaled.detail).toMatchObject({ layer: "product" });
    expect(failed(checks)).toEqual(["ASSET_UPSCALED"]);
    expect(failedBlockers(checks)).toEqual([]);
  });

  it("calibration: both demo brands pass every template", async () => {
    for (const brandName of ["lumora", "kestrel"] as const)
      for (const template of CREATIVE_TEMPLATE_IDS) {
        const { result, art, reservedZones } = await compose(
          brandName,
          template,
        );
        const checks = [
          ...checkComposition(result, approvedOf(result)),
          ...(await checkArt(art.bytes, reservedZones)),
        ];
        expect(
          failedBlockers(checks),
          `${brandName} ${template}: ${JSON.stringify(checks.filter((c) => !c.passed))}`,
        ).toEqual([]);
      }
  }, 120_000);
});
