/**
 * Renders the two fictional demo brands (spec §12) for visual inspection,
 * offline and at no cost: every template in its default variant on every
 * format, plus the bad-art cases of acceptance test C.
 *
 *   node scripts/creative-demo.ts [outDir]     default .runtime/creative-demo
 *
 * Writes `<brand>/<template>-<format>.png`, `bad-art/<brand>-<kind>-<format>.png`,
 * `report.json` (the QA checks of every file) and `contact-sheet.png`. Exits 1
 * when a render from good art has a failed blocker, or when bad art passes
 * both art checks (test C). The default variant is
 * the resolver's (R12, R16): on landscape the template's first side variant,
 * else its first variant for the format. Art is fixture art in the image
 * model's source size closest to the layout's art box, as production asks
 * for it; products are drawn only where the template requires them.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  artZones,
  checkArt,
  checkComposition,
  composeCreative,
  CREATIVE_FORMAT_IDS,
  CREATIVE_TEMPLATE_IDS,
  drawnArt,
  failedBlockers,
  layoutFor,
  TEMPLATE_NEEDS,
  variantsFor,
  type CreativeCheck,
  type CreativeCopy,
  type FormatId,
  type LayoutSpec,
  type RasterSource,
  type Sharp,
  type TemplateId,
  type VariantId,
} from "../packages/creative/src/index.ts";
import {
  demoBrand,
  fixtureArt,
  fixtureScreenshot,
  type DemoBrandName,
  type FixtureArtKind,
} from "../packages/creative/fixtures/demo-brands.ts";

const OUT = process.argv[2] ?? join(".runtime", "creative-demo");
const BRANDS: readonly DemoBrandName[] = ["lumora", "kestrel"];
const COPY: Record<DemoBrandName, CreativeCopy> = {
  lumora: {
    eyebrow: "New this autumn",
    headline: "Evenings feel softer in warm light",
    subline:
      "Lamps, throws and textures that turn any room into a calm retreat.",
    cta: "Shop the collection",
  },
  kestrel: {
    eyebrow: "Weekly insight",
    headline: "See every metric that moves your team",
    subline:
      "Dashboards that update themselves, so Monday starts with answers.",
    cta: "Start free trial",
  },
};
/** The image model's source sizes (packages/ai IMAGE_SIZES). */
const SOURCE_SIZES = [
  { width: 1024, height: 1024 },
  { width: 1536, height: 1024 },
  { width: 1024, height: 1536 },
] as const;
const OPTIONS = { logoPlacement: "auto", textScale: "m" } as const;
const SIDE: readonly VariantId[] = [
  "text_side",
  "product_left",
  "product_right",
];

type Entry = {
  file: string;
  brand: DemoBrandName;
  template: TemplateId;
  variant: VariantId;
  /** The default variant, when a free correction drew another one. */
  correctedFrom?: VariantId;
  format: FormatId;
  art: FixtureArtKind | null;
  scrimOpacity?: number;
  ctaStyle?: string;
  checks: CreativeCheck[];
  failed: string[];
  error?: string;
};

function defaultVariant(template: TemplateId, format: FormatId): VariantId {
  const offered = variantsFor(template, format);
  if (format === "landscape") {
    const side = offered.find((v) => SIDE.includes(v));
    if (side) return side;
  }
  return offered[0]!;
}

/** The source size whose aspect is closest to the art box (as `sourceSizeFor`). */
function sourceSize(layout: LayoutSpec) {
  const box = layout.art ?? { w: 1, h: 1 };
  const target = box.w / box.h;
  return SOURCE_SIZES.reduce((best, size) =>
    Math.abs(Math.log(size.width / size.height / target)) <
    Math.abs(Math.log(best.width / best.height / target))
      ? size
      : best,
  );
}

/** Codes the service corrects for free with another variant (R22, R23). */
const VARIANT_CORRECTED = ["TEXT_BACKDROP_BUSY", "TEXT_CONTRAST_LOW"];

/** One composition and its QA, as the service judges it. */
async function attempt(
  brandName: DemoBrandName,
  template: TemplateId,
  variant: VariantId,
  format: FormatId,
  kind: FixtureArtKind | null,
) {
  const brand = await demoBrand(brandName);
  const layout = layoutFor(template, variant, format, OPTIONS);
  const art: RasterSource | undefined =
    kind && layout.art
      ? await fixtureArt(kind, brandName, sourceSize(layout))
      : undefined;
  const products =
    TEMPLATE_NEEDS[template].product === "required"
      ? [await fixtureScreenshot(brandName)]
      : [];
  const result = await composeCreative({
    template,
    variant,
    format,
    brand,
    copy: COPY[brandName],
    art,
    products,
    options: OPTIONS,
  });
  // Art in its drawn frame, without an empty product zone (R15, R21).
  const zones = artZones(
    products.length
      ? layout
      : { ...layout, reservedZones: layout.reservedZones.slice(0, 2) },
  );
  const checks = [
    ...checkComposition(result, {
      logoSha256: brand.logos.map((l) => l.sha256),
      productSha256: products.map((p) => p.sha256),
    }),
    ...(art ? await checkArt(await drawnArt(art, layout), zones) : []),
  ];
  return { result, checks, failed: failedBlockers(checks) as string[] };
}

/**
 * Renders one template on one format in its default variant; a busy or
 * low-contrast text backdrop gets the service's free correction, the
 * template's next variant (R22), and the attempt with fewer failures stays.
 */
async function render(
  brandName: DemoBrandName,
  template: TemplateId,
  format: FormatId,
  kind: FixtureArtKind | null,
  file: string,
): Promise<Entry> {
  const first = defaultVariant(template, format);
  const entry: Entry = {
    file,
    brand: brandName,
    template,
    variant: first,
    format,
    art: kind,
    checks: [],
    failed: [],
  };
  try {
    let best:
      (Awaited<ReturnType<typeof attempt>> & { variant: VariantId }) | null =
      null;
    const others = variantsFor(template, format).filter((v) => v !== first);
    for (const variant of [first, ...others]) {
      const tried = {
        ...(await attempt(brandName, template, variant, format, kind)),
        variant,
      };
      if (!best || tried.failed.length < best.failed.length) best = tried;
      if (
        !best.failed.length ||
        !best.failed.every((code) => VARIANT_CORRECTED.includes(code))
      )
        break;
    }
    writeFileSync(join(OUT, file), best!.result.png);
    Object.assign(entry, {
      variant: best!.variant,
      ...(best!.variant !== first && { correctedFrom: first }),
      checks: best!.checks,
      failed: best!.failed,
      scrimOpacity: Number(best!.result.scrimOpacity.toFixed(2)),
      ctaStyle: best!.result.ctaStyleApplied,
    });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    entry.error = err.code ?? err.message ?? String(error);
    entry.failed = [entry.error];
  }
  return entry;
}

/** One sheet: per brand a block of rows (templates) by columns (formats), labelled. */
async function contactSheet(entries: Entry[]) {
  // sharp is the creative package's dependency: resolve it from there.
  const sharp = createRequire(
    new URL("../packages/creative/package.json", import.meta.url),
  )("sharp") as Sharp;
  const cellH = 360;
  const pad = 16;
  const label = 50;
  const widths = CREATIVE_FORMAT_IDS.map((format) => {
    const sample = entries.find((e) => e.format === format && !e.error)!;
    const layout = layoutFor(sample.template, sample.variant, format, OPTIONS);
    return Math.round((layout.format.width / layout.format.height) * cellH);
  });
  const rowW = pad + widths.reduce((sum, w) => sum + w + pad, 0);
  const rowH = label + cellH + pad;
  const rows = BRANDS.flatMap((brand) =>
    CREATIVE_TEMPLATE_IDS.map((template) => ({ brand, template })),
  );
  const width = rowW;
  const height = pad + rows.length * rowH;
  const overlays: { input: Buffer; left: number; top: number }[] = [];
  const text: string[] = [];
  for (const [r, { brand, template }] of rows.entries()) {
    const top = pad + r * rowH;
    let left = pad;
    text.push(
      `<text x="${pad}" y="${top + 20}" font-family="DejaVu Sans" font-size="19" font-weight="bold" fill="#111">${brand === "lumora" ? "Lumora Home" : "Kestrel Analytics"} · ${template}</text>`,
    );
    for (const [c, format] of CREATIVE_FORMAT_IDS.entries()) {
      const entry = entries.find(
        (e) =>
          e.brand === brand &&
          e.template === template &&
          e.format === format &&
          e.art !== "tiny_subject" &&
          e.art !== "flat",
      );
      const status = entry?.failed.length
        ? ` FAIL ${entry.failed.join(",")}`
        : "";
      text.push(
        `<text x="${left}" y="${top + 42}" font-family="DejaVu Sans" font-size="13" fill="${status ? "#B3261E" : "#555"}">${format} · ${entry?.variant ?? ""}${status}</text>`,
      );
      if (entry && !entry.error)
        overlays.push({
          input: await sharp(join(OUT, entry.file))
            .resize({ height: cellH })
            .png()
            .toBuffer(),
          left,
          top: top + label,
        });
      left += widths[c]! + pad;
    }
  }
  const labels = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${text.join("")}</svg>`,
  );
  await sharp({
    create: { width, height, channels: 3, background: "#EDEDED" },
  })
    .composite([...overlays, { input: labels, left: 0, top: 0 }])
    .png()
    .toFile(join(OUT, "contact-sheet.png"));
}

const entries: Entry[] = [];
for (const brand of BRANDS) {
  mkdirSync(join(OUT, brand), { recursive: true });
  for (const template of CREATIVE_TEMPLATE_IDS)
    for (const format of CREATIVE_FORMAT_IDS)
      entries.push(
        await render(
          brand,
          template,
          format,
          "good",
          join(brand, `${template}-${format}.png`),
        ),
      );
}
// Acceptance test C: weak art must be found by the art checks.
mkdirSync(join(OUT, "bad-art"), { recursive: true });
for (const brand of BRANDS)
  for (const kind of ["tiny_subject", "flat"] as const)
    for (const format of ["feed_portrait", "landscape"] as const)
      entries.push(
        await render(
          brand,
          "lifestyle",
          format,
          kind,
          join("bad-art", `${brand}-${kind}-${format}.png`),
        ),
      );
writeFileSync(join(OUT, "report.json"), JSON.stringify(entries, null, 2));
await contactSheet(entries);

const good = entries.filter((e) => e.art === "good" || e.art === null);
const failing = good.filter((e) => e.failed.length);
const bad = entries.filter((e) => e.art === "tiny_subject" || e.art === "flat");
const missed = bad.filter(
  (e) =>
    !e.failed.some((code) =>
      ["SUBJECT_TOO_SMALL", "EMPTY_AREA_EXCESSIVE"].includes(code),
    ),
);
console.log(
  `${good.length} renders from good art, ${failing.length} with a failed blocker; ` +
    `${bad.length} bad-art renders, ${missed.length} not flagged. Output: ${OUT}`,
);
for (const e of [...failing, ...missed])
  console.log(`  ${e.file}: ${e.failed.join(", ") || "not flagged"}`);
process.exitCode = failing.length || missed.length ? 1 : 0;
