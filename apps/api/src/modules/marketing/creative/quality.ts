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
 * rendition or banner), approved for `use` and stored with the SHA-256 of
 * its bytes. The detail lists each refused asset with its reason
 * (`not_found`, `not_approved`, `bound`, `use_not_approved`, `no_sha256`), in
 * the order given.
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
            : // Only bytes with a stored SHA-256 can be drawn as approved.
              !/^[0-9a-f]{64}$/iu.test(String(d.sha256 ?? ""))
              ? "no_sha256"
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
 * Findings that refuse a creative (R34, spec §9 "refuse"): never corrected,
 * never accepted by the owner, and nothing is stored with them.
 */
export const REFUSALS = [
  "ASSET_RIGHTS",
  "LOGO_INTEGRITY",
  "SCREENSHOT_INTEGRITY",
] as const;
export type Refusal = (typeof REFUSALS)[number];

/** The first failed code that refuses the creative, or null. */
export function creativeRefusal(failed: readonly string[]): Refusal | null {
  return (
    (failed.find((code) => (REFUSALS as readonly string[]).includes(code)) as
      Refusal | undefined) ?? null
  );
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
 * The new art weak art calls for (spec §9): only Orbit's own art with
 * attempts left (uploaded art is the owner's), never beside a refusal.
 * Paid, so only a caller may start it.
 */
export function artCorrectionFor(
  state: Pick<
    CorrectionState,
    "artIsOrbitGenerated" | "artAttempts" | "maxArtCorrections"
  >,
  failed: Array<CreativeCheck["code"] | "TEXT_OVERFLOW">,
): ArtCorrection | null {
  if (
    !state.artIsOrbitGenerated ||
    state.artAttempts >= state.maxArtCorrections ||
    creativeRefusal(failed)
  )
    return null;
  if (failed.includes("SUBJECT_TOO_SMALL")) return { kind: "subject_larger" };
  if (failed.includes("EMPTY_AREA_EXCESSIVE")) return { kind: "more_detail" };
  return null;
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
 * - subject or empty area: another variant (free), then new art for
 *   Orbit's own art with attempts left (R35).
 * Beside a refusal (`REFUSALS`, R34) nothing is corrected; render faults
 * stay for the owner.
 */
export function planCorrection(
  state: CorrectionState,
  failed: Array<CreativeCheck["code"] | "TEXT_OVERFLOW">,
): Correction | null {
  if (creativeRefusal(failed)) return null;
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
      const correction = artCorrectionFor(state, failed);
      return nextVariant(state) ?? (correction && { kind: "art", correction });
    },
  ];
  for (const category of categories) {
    const correction = category();
    if (correction) return correction;
  }
  return null;
}
