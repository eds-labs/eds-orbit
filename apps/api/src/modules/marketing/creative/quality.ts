import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import {
  variantsFor,
  type CreativeCheck,
  type FormatId,
  type LogoRole,
  type TemplateId,
  type TextScale,
  type VariantId,
} from "../../../../../../packages/creative/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { data, DomainError } from "../../../shared.ts";
import { isApprovedAsset } from "../brand/asset-rules.ts";
import type { ArtCorrection } from "./art-direction.ts";
import type { EntityRow } from "./brand-kit.ts";
import { projectAssets } from "./components.ts";

// The service's part of creative QA (spec §9): the rights of the components
// and the choice of the next free correction. The engine's checks
// (`checkComposition`, `checkArt`) measure the images.

/** What a creative's components must be approved for. */
export type CreativeUse = "social";

/**
 * `ASSET_RIGHTS`: every component, read again in `tx`, is an asset of this
 * project, approved with its usage rights, not bound to a post (a composed
 * rendition or banner) and approved for `use`. The detail lists each refused
 * asset with its reason (`not_found`, `not_approved`, `bound`,
 * `use_not_approved`), in the order given.
 */
export async function rightsCheck(
  tx: DbTx,
  scope: Scope,
  rows: EntityRow[],
  use: CreativeUse,
): Promise<CreativeCheck> {
  const ids = [...new Set(rows.map((row) => row.id))];
  const current = await projectAssets(tx, scope, ids);
  const refused: Array<{ id: string; reason: string }> = [];
  for (const id of ids) {
    const row = current.get(id);
    const d = data(row);
    const reason = !row
      ? "not_found"
      : !isApprovedAsset(d)
        ? "not_approved"
        : d.boundTo
          ? "bound"
          : !(Array.isArray(d.validUses) && d.validUses.includes(use))
            ? "use_not_approved"
            : null;
    if (reason) refused.push({ id, reason });
  }
  return refused.length
    ? {
        code: "ASSET_RIGHTS",
        passed: false,
        severity: "blocker",
        detail: {
          assetIds: refused.map((r) => r.id).join(","),
          reasons: refused.map((r) => r.reason).join(","),
        },
      }
    : { code: "ASSET_RIGHTS", passed: true, severity: "blocker" };
}

/** 409 `ASSET_RIGHTS`: a refusal, never corrected (R22); `detail` names the assets. */
export class CreativeRightsError extends DomainError {
  constructor(readonly detail: Record<string, string | number>) {
    super("ASSET_RIGHTS", 409);
  }
}

/** Throws `CreativeRightsError` when the rights check failed. */
export function assertRights(check: CreativeCheck): void {
  if (!check.passed) throw new CreativeRightsError(check.detail ?? {});
}

/**
 * One free correction (spec §9), or the paid art regeneration the findings
 * call for, which only the caller may start.
 */
export type Correction =
  | { kind: "scrim" }
  | { kind: "variant"; variant: VariantId }
  | { kind: "logo_variant"; role: LogoRole }
  | { kind: "text_scale"; scale: TextScale }
  | { kind: "art"; correction: ArtCorrection };

/** Where the corrections of one format stand. */
export type CorrectionState = {
  template: TemplateId;
  format: FormatId;
  variant: VariantId;
  /** Variants this format was composed in so far, the current one included. */
  tried: VariantId[];
  /** A person chose the variant: corrections never switch it (R31). */
  variantFixed: boolean;
  scrimBoost: number;
  /** The scrim compose drew and the layout's maximum (R22). */
  scrimOpacity: number;
  scrimMax: number;
  textScale: TextScale;
  /** Logo variants of the brand kit not drawn yet. */
  logoRoles: LogoRole[];
  artAttempts: number;
  maxArtCorrections: number;
  /** Only art Orbit generated is regenerated; uploaded art is the owner's. */
  artIsOrbitGenerated: boolean;
};

const MAX_SCRIM_BOOST = 3;
/** Other layout variants a format may try (spec §9). */
const MAX_VARIANT_SWITCHES = 2;

/** The format's next untried variant, unless a person chose it or two were tried. */
function nextVariant(state: CorrectionState): Correction | null {
  if (state.variantFixed || state.tried.length > MAX_VARIANT_SWITCHES)
    return null;
  const variant = variantsFor(state.template, state.format).find(
    (candidate) => !state.tried.includes(candidate),
  );
  return variant ? { kind: "variant", variant } : null;
}

/**
 * The next correction for a format's failed blockers, or null when none is
 * left. Categories in priority order, the first with a correction wins:
 * - text contrast or busy backdrop: a stronger scrim only for low contrast
 *   while the drawn scrim is below the layout's maximum (compose already
 *   raised it to the maximum for contrast and to its busy limit for
 *   busyness, R17, R23), else another variant (R22);
 * - logo contrast: another logo variant;
 * - overflow: another variant, then the small text scale;
 * - subject or empty area: new art for Orbit's own art with attempts left,
 *   else another variant.
 * Missing rights (`ASSET_RIGHTS`) are a refusal and are never corrected;
 * render faults stay for the owner.
 */
export function planCorrection(
  state: CorrectionState,
  failed: Array<CreativeCheck["code"] | "TEXT_OVERFLOW">,
): Correction | null {
  if (failed.includes("ASSET_RIGHTS")) return null;
  const has = (...codes: Array<CreativeCheck["code"] | "TEXT_OVERFLOW">) =>
    codes.some((code) => failed.includes(code));
  const categories: Array<() => Correction | null> = [
    () => {
      if (!has("TEXT_CONTRAST_LOW", "TEXT_BACKDROP_BUSY")) return null;
      if (
        has("TEXT_CONTRAST_LOW") &&
        state.scrimOpacity < state.scrimMax &&
        state.scrimBoost < MAX_SCRIM_BOOST
      )
        return { kind: "scrim" };
      return nextVariant(state);
    },
    () =>
      has("LOGO_CONTRAST_LOW") && state.logoRoles.length
        ? { kind: "logo_variant", role: state.logoRoles[0]! }
        : null,
    () => {
      if (!has("TEXT_OVERFLOW")) return null;
      return (
        nextVariant(state) ??
        (state.textScale !== "s" ? { kind: "text_scale", scale: "s" } : null)
      );
    },
    () => {
      if (!has("SUBJECT_TOO_SMALL", "EMPTY_AREA_EXCESSIVE")) return null;
      if (
        state.artIsOrbitGenerated &&
        state.artAttempts < state.maxArtCorrections
      )
        return {
          kind: "art",
          correction: {
            kind: has("SUBJECT_TOO_SMALL") ? "subject_larger" : "more_detail",
          },
        };
      return nextVariant(state);
    },
  ];
  for (const category of categories) {
    const correction = category();
    if (correction) return correction;
  }
  return null;
}
