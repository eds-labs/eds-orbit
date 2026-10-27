import {
  CREATIVE_THRESHOLDS,
  analyzeArt,
  requiredTextContrast,
} from "./analysis.ts";
import type { ComposeResult, LayerRecord } from "./compose.ts";
import { CREATIVE_FORMATS } from "./formats.ts";
import { CreativeError } from "./errors.ts";
import { openRaster, worstContrast } from "./raster.ts";
import type { Box, RelBox, TextLayerKind } from "./templates.ts";

// Deterministic creative checks (spec §9). Composition checks read the
// manifest compose records (layers, backdrops, PNG header); art checks
// measure the art. Corrections are chosen by the service, not here.

export type CreativeCheckCode =
  | "CREATIVE_DIMENSIONS"
  | "CREATIVE_FILE_TOO_LARGE"
  | "TEXT_CONTRAST_LOW"
  | "TEXT_BACKDROP_BUSY"
  | "LOGO_CONTRAST_LOW"
  | "LOGO_INTEGRITY"
  | "SCREENSHOT_INTEGRITY"
  | "SUBJECT_TOO_SMALL"
  | "EMPTY_AREA_EXCESSIVE"
  | "SAFE_AREA_VIOLATION"
  | "LAYER_OVERLAP"
  | "ASSET_UPSCALED";

/**
 * Findings the service checks itself: the rights of the components
 * (`ASSET_RIGHTS`) and the image copy's wording (the banner copy rules: a
 * figure or status word, a promise or prohibited wording, a bare host).
 */
export type ServiceCheckCode =
  | "ASSET_RIGHTS"
  | "CREATIVE_UNSUPPORTED_CLAIM"
  | "CREATIVE_PROHIBITED_LANGUAGE"
  | "LINK_UNVERIFIED";

/** One check's outcome; the `ServiceCheckCode`s are checked by the service. */
export type CreativeCheck = {
  code: CreativeCheckCode | ServiceCheckCode;
  passed: boolean;
  severity: "blocker" | "warning";
  detail?: Record<string, number | string>;
};

const TEXT_KINDS: readonly TextLayerKind[] = [
  "eyebrow",
  "headline",
  "subline",
  "cta",
];
/** Layers that must sit inside the safe area without overlapping (art and scrim may bleed). */
const PLACED_KINDS: readonly LayerRecord["kind"][] = [
  ...TEXT_KINDS,
  "product",
  "logo",
  "logo_plate",
];
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const check = (
  code: CreativeCheckCode,
  passed: boolean,
  detail?: CreativeCheck["detail"],
  severity: CreativeCheck["severity"] = "blocker",
): CreativeCheck => ({ code, passed, severity, ...(detail && { detail }) });
const round = (value: number) => Math.round(value * 1000) / 1000;
const isText = (
  layer: LayerRecord,
): layer is LayerRecord & {
  kind: TextLayerKind;
} => TEXT_KINDS.includes(layer.kind as TextLayerKind);
const inside = (box: Box, outer: Box) =>
  box.x >= outer.x &&
  box.y >= outer.y &&
  box.x + box.w <= outer.x + outer.w &&
  box.y + box.h <= outer.y + outer.h;
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Width and height from a PNG's IHDR chunk, or `null` when the bytes are no PNG. */
function pngSize(png: Buffer) {
  if (
    png.length < 24 ||
    !png.subarray(0, 8).equals(PNG_SIGNATURE) ||
    png.toString("latin1", 12, 16) !== "IHDR"
  )
    return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** The drawn box keeps the source's aspect to within one pixel along its shorter side. */
function aspectKept(layer: LayerRecord) {
  const source = layer.sourceSize;
  if (!source?.width || !source.height) return false;
  return (
    Math.abs(layer.box.h * source.width - layer.box.w * source.height) <=
    Math.max(source.width, source.height)
  );
}

/** Approved bytes with their aspect kept; `minSide` is a floor for the drawn box's longer side (logos). */
function integrity(
  code: "LOGO_INTEGRITY" | "SCREENSHOT_INTEGRITY",
  layers: LayerRecord[],
  approved: string[],
  minSide = 0,
) {
  const hashes = new Set(approved.map((sha) => sha.toLowerCase()));
  for (const layer of layers) {
    const reason = !hashes.has(layer.sourceSha256?.toLowerCase() ?? "")
      ? "not_approved"
      : !aspectKept(layer)
        ? "aspect_changed"
        : Math.max(layer.box.w, layer.box.h) < minSide
          ? "too_small"
          : null;
    if (reason) return check(code, false, { layer: layer.kind, reason });
  }
  return check(code, true);
}

type Measured = { score: number; ok: boolean; detail: Record<string, number> };

/** The worst text layer by `score` (lowest first); the check fails when it is not `ok`. */
function worstText(
  code: "TEXT_CONTRAST_LOW" | "TEXT_BACKDROP_BUSY",
  result: ComposeResult,
  measure: (layer: LayerRecord & { kind: TextLayerKind }) => Measured | null,
) {
  let worst: (Measured & { layer: TextLayerKind }) | null = null;
  for (const layer of result.layers.filter(isText)) {
    const measured = measure(layer);
    // A text layer without its recorded colour or backdrop cannot be verified.
    if (!measured)
      return check(code, false, { layer: layer.kind, reason: "unrecorded" });
    if (!worst || measured.score < worst.score)
      worst = { layer: layer.kind, ...measured };
  }
  return worst
    ? check(code, worst.ok, { layer: worst.layer, ...worst.detail })
    : check(code, true);
}

/**
 * Checks a composition against its manifest: one check per code, in a fixed
 * order. Text and logo contrast use the recorded colours and backdrops as
 * compose measured them (worst case of p10/p90); `approved` holds the
 * SHA-256 values the logo and screenshot layers must carry.
 */
export function checkComposition(
  result: ComposeResult,
  approved: { logoSha256: string[]; productSha256: string[] },
): CreativeCheck[] {
  const T = CREATIVE_THRESHOLDS;
  const format = Object.hasOwn(CREATIVE_FORMATS, result.format)
    ? CREATIVE_FORMATS[result.format]
    : null;
  const size = pngSize(result.png);
  const logos = result.layers.filter((l) => l.kind === "logo");
  const logo = logos[0];
  const logoBackdrop = result.backdrops.logo;
  const placed = result.layers.filter((l) => PLACED_KINDS.includes(l.kind));
  const safe = format && {
    x: format.safe.left,
    y: format.safe.top,
    w: format.width - format.safe.left - format.safe.right,
    h: format.height - format.safe.top - format.safe.bottom,
  };
  const outside = placed.find((l) => !safe || !inside(l.box, safe));
  let overlap: string | null = null;
  for (const [i, a] of placed.entries())
    for (const b of placed.slice(i + 1)) {
      // The plate is drawn behind its logo on purpose.
      const plated = new Set([a.kind, b.kind]);
      if (plated.has("logo") && plated.has("logo_plate")) continue;
      if (!overlap && overlaps(a.box, b.box)) overlap = `${a.kind}/${b.kind}`;
    }
  const upscaled = result.layers
    .filter((l) => l.scale !== undefined)
    .reduce<LayerRecord | null>(
      (top, l) => (!top || l.scale! > top.scale! ? l : top),
      null,
    );
  const logoContrast =
    logo?.color && logoBackdrop ? worstContrast(logo.color, logoBackdrop) : 0;

  return [
    check(
      "CREATIVE_DIMENSIONS",
      !!format &&
        size?.width === format.width &&
        size.height === format.height &&
        result.width === format.width &&
        result.height === format.height,
      {
        width: size?.width ?? 0,
        height: size?.height ?? 0,
        expectedWidth: format?.width ?? 0,
        expectedHeight: format?.height ?? 0,
      },
    ),
    check("CREATIVE_FILE_TOO_LARGE", result.png.length <= T.maxFileBytes, {
      bytes: result.png.length,
      maximum: T.maxFileBytes,
    }),
    worstText("TEXT_CONTRAST_LOW", result, (layer) => {
      const backdrop = result.backdrops[layer.kind];
      if (!backdrop || !layer.color || !layer.fontSize) return null;
      const contrast = worstContrast(layer.color, backdrop);
      const required = requiredTextContrast(layer.kind, layer.fontSize);
      return {
        score: contrast / required,
        ok: contrast >= required,
        detail: { contrast: round(contrast), required },
      };
    }),
    worstText("TEXT_BACKDROP_BUSY", result, (layer) => {
      const busy = result.backdrops[layer.kind]?.busy;
      if (busy === undefined) return null;
      return {
        score: -busy,
        ok: busy <= T.busyText,
        detail: { busy: round(busy), maximum: T.busyText },
      };
    }),
    check("LOGO_CONTRAST_LOW", logoContrast >= T.logoContrast, {
      contrast: round(logoContrast),
      required: T.logoContrast,
    }),
    logos.length
      ? integrity(
          "LOGO_INTEGRITY",
          logos,
          approved.logoSha256,
          T.minLogoSideShare * Math.min(result.width, result.height),
        )
      : check("LOGO_INTEGRITY", false, { reason: "missing" }),
    integrity(
      "SCREENSHOT_INTEGRITY",
      result.layers.filter((l) => l.kind === "product"),
      approved.productSha256,
    ),
    check(
      "SAFE_AREA_VIOLATION",
      !outside,
      outside ? { layer: outside.kind } : undefined,
    ),
    check("LAYER_OVERLAP", !overlap, overlap ? { layers: overlap } : undefined),
    check(
      "ASSET_UPSCALED",
      !upscaled || upscaled.scale! <= T.maxUpscale,
      upscaled
        ? {
            layer: upscaled.kind,
            scale: round(upscaled.scale!),
            maximum: T.maxUpscale,
          }
        : undefined,
      "warning",
    ),
  ];
}

/** Pixel size of raster bytes; undecodable bytes are `RASTER_INPUT_INVALID`. */
async function rasterSize(bytes: Buffer) {
  const { default: sharp } = await import("sharp");
  try {
    const { width = 0, height = 0 } = await openRaster(sharp, bytes).metadata();
    if (width && height) return { width, height };
  } catch {
    // Reported below.
  }
  throw new CreativeError("RASTER_INPUT_INVALID");
}

/**
 * Subject size and empty area of an art, judged in the frame it is drawn in
 * (R21): `png` is `drawnArt(art, layout)` and `reserved` is
 * `artZones(layout)` (fractions of the drawn art). A drawn art box beyond
 * `maxArtAspect` (4:1 either way) is a decorative strip: both checks pass
 * with `detail.skipped = "ART_STRIP"` (R24). Art in a band beyond
 * `maxBlockingEmptyAspect` (2.5:1) is judged for its subject only: its
 * empty area is a warning with `detail.band = "ART_BAND"` (R60).
 */
export async function checkArt(
  png: Buffer,
  reserved: RelBox[],
): Promise<CreativeCheck[]> {
  const T = CREATIVE_THRESHOLDS;
  const { width, height } = await rasterSize(png);
  if (width > T.maxArtAspect * height || height > T.maxArtAspect * width)
    // A decorative strip: no motif to judge, and new art could not change that (R24).
    return [
      check("SUBJECT_TOO_SMALL", true, { skipped: "ART_STRIP" }),
      check("EMPTY_AREA_EXCESSIVE", true, { skipped: "ART_STRIP" }),
    ];
  const { subjectCoverage, flatShare } = await analyzeArt(png, reserved);
  const band =
    width > T.maxBlockingEmptyAspect * height ||
    height > T.maxBlockingEmptyAspect * width;
  return [
    check("SUBJECT_TOO_SMALL", subjectCoverage >= T.subjectMinCoverage, {
      subjectCoverage: round(subjectCoverage),
      minimum: T.subjectMinCoverage,
    }),
    // A band behind or beside text is mostly background by design (R60).
    band
      ? check(
          "EMPTY_AREA_EXCESSIVE",
          flatShare <= T.flatMaxShare,
          {
            flatShare: round(flatShare),
            maximum: T.flatMaxShare,
            band: "ART_BAND",
          },
          "warning",
        )
      : check("EMPTY_AREA_EXCESSIVE", flatShare <= T.flatMaxShare, {
          flatShare: round(flatShare),
          maximum: T.flatMaxShare,
        }),
  ];
}

/**
 * Codes of the failed blockers, in check order. A failed `ASSET_RIGHTS`
 * check (the service's) is included too, so it can never pass unnoticed.
 */
export function failedBlockers(
  checks: CreativeCheck[],
): CreativeCheck["code"][] {
  return checks
    .filter((c) => !c.passed && c.severity === "blocker")
    .map((c) => c.code);
}
