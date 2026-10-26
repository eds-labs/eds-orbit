import {
  artZones,
  checkArt,
  checkComposition,
  composeCreative,
  CreativeError,
  drawnArt,
  failedBlockers,
  layoutFor,
  type ComposeResult,
  type CreativeBrand,
  type CreativeCheck,
  type CreativeCopy,
  type FormatId,
  type LayoutSpec,
  type LogoPlacement,
  type LogoRole,
  type RasterSource,
  type TextScale,
  type VariantId,
} from "../../../../../../packages/creative/src/index.ts";
import type { ArtCorrection } from "./art-direction.ts";
import { variantForFormat, type ResolvedBrief } from "./brief.ts";
import { planCorrection, type CorrectionState } from "./quality.ts";
import type { CreativeRecord } from "./store.ts";

// The composition core (R6): one rendition per format with free corrections
// and art checks, outside any transaction and without cost. Produce,
// recompose, assignment runs and packages all compose through it; saving,
// rights and paid art stay with the callers.

/** Free corrections per format before the findings stay for the owner (spec §9). */
const MAX_FREE_CORRECTIONS = 4;

export type RenditionInput = {
  brand: CreativeBrand;
  /** The creative's template, variant and formats; each format adapts the variant (R1). */
  brief: Pick<ResolvedBrief, "template" | "variant" | "formats">;
  copy: CreativeCopy;
  art?: RasterSource;
  /** The screenshot or product image the layout shows (at most one), or none. */
  products: RasterSource[];
  options: { logoPlacement: LogoPlacement; textScale: TextScale };
  /** A person chose the variant: corrections never switch it (R31). */
  variantFixed: boolean;
  /** Whether the art is Orbit's own and how many paid regenerations are left. */
  artState: {
    orbitGenerated: boolean;
    attempts: number;
    maxCorrections: number;
  };
};

/** One composed format with its final checks (each tagged with the format). */
export type ComposedRendition = {
  format: FormatId;
  variant: VariantId;
  textScale: TextScale;
  result: ComposeResult;
  checks: CreativeCheck[];
};

/** A free correction as stored on the creative: what changed, why, where. */
export type RenditionCorrection = CreativeRecord["corrections"][number] & {
  format: FormatId;
  value?: string;
};

export type CompositionOutcome = {
  /** In the order of the formats; a format whose copy never fit has none. */
  renditions: ComposedRendition[];
  /** Formats whose copy does not fit even after the corrections. */
  overflow: FormatId[];
  /** Every rendition's final checks. */
  checks: CreativeCheck[];
  /** The failed blockers left, unique, `TEXT_OVERFLOW` included. */
  failed: Array<CreativeCheck["code"] | "TEXT_OVERFLOW">;
  corrections: RenditionCorrection[];
  /**
   * The art regeneration the findings call for (Orbit's own art with attempts
   * left); it costs money, so only the caller may start it.
   */
  artCorrection: ArtCorrection | null;
  /** `pass` without corrections, `corrected` after free ones, else `needs_owner`. */
  verdict: "pass" | "corrected" | "needs_owner";
};

const tagged = (checks: CreativeCheck[], format: FormatId) =>
  checks.map((check) => ({
    ...check,
    detail: { ...check.detail, format },
  }));

/**
 * Composes the brief's formats from the same art, copy and approved
 * components. Each format gets at most four free corrections (scrim, other
 * variant, other logo variant, small text scale) chosen by `planCorrection`;
 * art is judged in its drawn frame without an empty product zone (R15, R21),
 * once per frame. A failed blocker without a free correction stays in the
 * outcome for the owner. Engine refusals other than `TEXT_OVERFLOW` (missing
 * art, tampered bytes, invalid input) are thrown as `CreativeError`.
 */
export async function composeRenditions(
  input: RenditionInput,
  deps: { compose?: typeof composeCreative } = {},
): Promise<CompositionOutcome> {
  const compose = deps.compose ?? composeCreative;
  const { brand, brief, art, products } = input;
  const approved = {
    logoSha256: brand.logos.map((logo) => logo.sha256),
    productSha256: products.map((product) => product.sha256),
  };
  const roles = [...new Set(brand.logos.map((logo) => logo.role))];
  // Art checks per drawn frame: corrections that keep the frame reuse them.
  const artChecks = new Map<string, Promise<CreativeCheck[]>>();
  const judgeArt = (layout: LayoutSpec) => {
    if (!art || !layout.art) return Promise.resolve([]);
    // Without a product the product zone stays empty and is not reserved (R15).
    const zones = artZones(
      products.length
        ? layout
        : { ...layout, reservedZones: layout.reservedZones.slice(0, 2) },
    );
    const key = JSON.stringify([layout.art, zones]);
    let checks = artChecks.get(key);
    if (!checks) {
      checks = drawnArt(art, layout).then((png) => checkArt(png, zones));
      artChecks.set(key, checks);
    }
    return checks;
  };

  const outcome: CompositionOutcome = {
    renditions: [],
    overflow: [],
    checks: [],
    failed: [],
    corrections: [],
    artCorrection: null,
    verdict: "pass",
  };
  for (const format of brief.formats) {
    const variant = variantForFormat(brief.template, format, brief.variant);
    const state: CorrectionState & { logoRole?: LogoRole } = {
      template: brief.template,
      format,
      variant,
      tried: [variant],
      variantFixed: input.variantFixed,
      scrimBoost: 0,
      scrimOpacity: 0,
      scrimMax: 0,
      textScale: input.options.textScale,
      logoRoles: roles,
      artAttempts: input.artState.attempts,
      maxArtCorrections: input.artState.maxCorrections,
      artIsOrbitGenerated: input.artState.orbitGenerated,
    };
    const drawnRoles = new Set<LogoRole>();
    let composed: ComposeResult | null = null;
    let checks: CreativeCheck[] = [];
    let failed: CompositionOutcome["failed"] = [];
    for (let corrections = 0; ; corrections++) {
      const options = {
        logoPlacement: input.options.logoPlacement,
        textScale: state.textScale,
      };
      const layout = layoutFor(state.template, state.variant, format, {
        ...options,
        logoRole: state.logoRole,
      });
      try {
        composed = await compose({
          template: state.template,
          variant: state.variant,
          format,
          brand,
          copy: input.copy,
          art,
          products,
          options,
          scrimBoost: state.scrimBoost as 0 | 1 | 2 | 3,
          logoRole: state.logoRole,
        });
      } catch (error) {
        if (!(error instanceof CreativeError) || error.code !== "TEXT_OVERFLOW")
          throw error;
        composed = null;
      }
      if (composed) {
        checks = [
          ...checkComposition(composed, approved),
          ...(await judgeArt(layout)),
        ];
        failed = failedBlockers(checks);
        drawnRoles.add(composed.logoRole);
        state.scrimOpacity = composed.scrimOpacity;
        state.scrimMax = layout.scrim?.max ?? 0;
      } else {
        checks = [];
        failed = ["TEXT_OVERFLOW"];
      }
      if (!failed.length || corrections >= MAX_FREE_CORRECTIONS) break;
      state.logoRoles = roles.filter((role) => !drawnRoles.has(role));
      const correction = planCorrection(state, failed);
      if (!correction) break;
      if (correction.kind === "art") {
        outcome.artCorrection ??= correction.correction;
        break;
      }
      let value: string | undefined;
      if (correction.kind === "scrim") state.scrimBoost += 1;
      else if (correction.kind === "variant") {
        state.variant = value = correction.variant;
        state.tried = [...state.tried, correction.variant];
      } else if (correction.kind === "logo_variant") {
        state.logoRole = value = correction.role;
      } else state.textScale = value = correction.scale;
      outcome.corrections.push({
        kind: correction.kind,
        reason: failed.join(","),
        at: new Date().toISOString(),
        format,
        ...(value !== undefined && { value }),
      });
    }
    if (composed)
      outcome.renditions.push({
        format,
        variant: state.variant,
        textScale: state.textScale,
        result: composed,
        checks: tagged(checks, format),
      });
    else outcome.overflow.push(format);
    outcome.checks.push(...tagged(checks, format));
    outcome.failed = [...new Set([...outcome.failed, ...failed])];
  }
  outcome.verdict = outcome.failed.length
    ? "needs_owner"
    : outcome.corrections.length
      ? "corrected"
      : "pass";
  return outcome;
}
