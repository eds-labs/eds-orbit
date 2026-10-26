import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { VariantId } from "../../../../../../packages/creative/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import type { EntityRow } from "./brand-kit.ts";
import {
  creativeRefusal,
  planCorrection,
  rightsCheck,
  type CorrectionState,
} from "./quality.ts";

const state = (changes: Partial<CorrectionState> = {}): CorrectionState => ({
  template: "lifestyle",
  format: "square",
  variant: "text_bottom",
  tried: ["text_bottom"],
  variantFixed: false,
  scrimBoost: 0,
  scrimOpacity: 0.85,
  scrimMax: 0.85,
  textScale: "m",
  logoRoles: [],
  artAttempts: 0,
  maxArtCorrections: 1,
  artIsOrbitGenerated: false,
  ...changes,
});

describe("planCorrection", () => {
  it("never corrects missing rights (a refusal, R22)", () => {
    expect(planCorrection(state(), ["ASSET_RIGHTS"])).toBeNull();
    expect(
      planCorrection(state({ scrimOpacity: 0.2 }), [
        "TEXT_CONTRAST_LOW",
        "ASSET_RIGHTS",
      ]),
    ).toBeNull();
  });

  it("strengthens the scrim for low contrast only while it is below the layout's maximum", () => {
    expect(
      planCorrection(state({ scrimOpacity: 0.4 }), ["TEXT_CONTRAST_LOW"]),
    ).toEqual({ kind: "scrim" });
    expect(
      planCorrection(state({ scrimOpacity: 0.4, scrimBoost: 3 }), [
        "TEXT_CONTRAST_LOW",
      ]),
    ).toEqual({ kind: "variant", variant: "text_top" });
    // Compose already drove the scrim to the maximum (R22).
    expect(planCorrection(state(), ["TEXT_CONTRAST_LOW"])).toEqual({
      kind: "variant",
      variant: "text_top",
    });
  });

  it("switches the variant for a busy backdrop, also below the maximum (R23)", () => {
    expect(
      planCorrection(state({ scrimOpacity: 0.6 }), ["TEXT_BACKDROP_BUSY"]),
    ).toEqual({ kind: "variant", variant: "text_top" });
  });

  it("tries untried variants of the format, at most two switches", () => {
    expect(
      planCorrection(state({ tried: ["text_bottom", "text_top"] }), [
        "TEXT_CONTRAST_LOW",
      ]),
    ).toEqual({ kind: "variant", variant: "text_side" });
    expect(
      planCorrection(
        state({ tried: ["text_bottom", "text_top", "text_side"] }),
        ["TEXT_CONTRAST_LOW"],
      ),
    ).toBeNull();
    // Side variants exist only where there is width (R1).
    expect(
      planCorrection(
        state({ format: "story", tried: ["text_bottom", "text_top"] }),
        ["TEXT_CONTRAST_LOW"],
      ),
    ).toBeNull();
  });

  it("never switches a variant a person chose (R31)", () => {
    expect(
      planCorrection(state({ variantFixed: true }), ["TEXT_BACKDROP_BUSY"]),
    ).toBeNull();
    expect(
      planCorrection(state({ variantFixed: true }), ["TEXT_OVERFLOW"]),
    ).toEqual({ kind: "text_scale", scale: "s" });
  });

  it("draws another logo variant for low logo contrast", () => {
    expect(
      planCorrection(state({ logoRoles: ["onDark", "mark"] }), [
        "LOGO_CONTRAST_LOW",
      ]),
    ).toEqual({ kind: "logo_variant", role: "onDark" });
    expect(planCorrection(state(), ["LOGO_CONTRAST_LOW"])).toBeNull();
  });

  it("answers overflow with a variant, then the small text scale", () => {
    expect(planCorrection(state(), ["TEXT_OVERFLOW"])).toEqual({
      kind: "variant",
      variant: "text_top",
    });
    const switched = state({ tried: ["text_bottom", "text_top", "text_side"] });
    expect(planCorrection(switched, ["TEXT_OVERFLOW"])).toEqual({
      kind: "text_scale",
      scale: "s",
    });
    expect(
      planCorrection({ ...switched, textScale: "s" }, ["TEXT_OVERFLOW"]),
    ).toBeNull();
  });

  it("tries the free variants first, then new art for Orbit's own art (R35)", () => {
    const generated = state({ artIsOrbitGenerated: true });
    expect(planCorrection(generated, ["SUBJECT_TOO_SMALL"])).toEqual({
      kind: "variant",
      variant: "text_top",
    });
    const switched = {
      ...generated,
      tried: ["text_bottom", "text_top", "text_side"] as VariantId[],
    };
    expect(planCorrection(switched, ["SUBJECT_TOO_SMALL"])).toEqual({
      kind: "art",
      correction: { kind: "subject_larger" },
    });
    expect(planCorrection(switched, ["EMPTY_AREA_EXCESSIVE"])).toEqual({
      kind: "art",
      correction: { kind: "more_detail" },
    });
    // A person's variant: straight to the art.
    expect(
      planCorrection({ ...generated, variantFixed: true }, [
        "SUBJECT_TOO_SMALL",
      ]),
    ).toEqual({ kind: "art", correction: { kind: "subject_larger" } });
    // No attempts left, or an uploaded art (the owner's, never regenerated).
    expect(
      planCorrection({ ...switched, artAttempts: 1 }, ["SUBJECT_TOO_SMALL"]),
    ).toBeNull();
    expect(
      planCorrection({ ...switched, artIsOrbitGenerated: false }, [
        "EMPTY_AREA_EXCESSIVE",
      ]),
    ).toBeNull();
    expect(planCorrection(state(), ["EMPTY_AREA_EXCESSIVE"])).toEqual({
      kind: "variant",
      variant: "text_top",
    });
  });

  it("leaves render faults to the owner", () => {
    for (const code of [
      "LAYER_OVERLAP",
      "SAFE_AREA_VIOLATION",
      "CREATIVE_DIMENSIONS",
    ] as const)
      expect(planCorrection(state(), [code])).toBeNull();
  });

  it("corrects nothing beside a refusal (R34)", () => {
    for (const code of [
      "ASSET_RIGHTS",
      "LOGO_INTEGRITY",
      "SCREENSHOT_INTEGRITY",
    ] as const)
      expect(
        planCorrection(state({ logoRoles: ["onDark"] }), [
          "TEXT_CONTRAST_LOW",
          "LOGO_CONTRAST_LOW",
          code,
        ]),
      ).toBeNull();
  });

  it("takes the first category with a correction left", () => {
    // No variant is left for the contrast, the logo still has one.
    expect(
      planCorrection(
        state({
          variantFixed: true,
          logoRoles: ["onLight"],
        }),
        ["TEXT_CONTRAST_LOW", "LOGO_CONTRAST_LOW"],
      ),
    ).toEqual({ kind: "logo_variant", role: "onLight" });
  });
});

describe("creativeRefusal", () => {
  it("names the first failure that refuses a creative (R34)", () => {
    expect(creativeRefusal(["TEXT_CONTRAST_LOW", "LOGO_INTEGRITY"])).toBe(
      "LOGO_INTEGRITY",
    );
    expect(creativeRefusal(["SCREENSHOT_INTEGRITY"])).toBe(
      "SCREENSHOT_INTEGRITY",
    );
    expect(creativeRefusal(["ASSET_RIGHTS", "TEXT_OVERFLOW"])).toBe(
      "ASSET_RIGHTS",
    );
    expect(
      creativeRefusal([
        "TEXT_OVERFLOW",
        "EMPTY_AREA_EXCESSIVE",
        "LAYER_OVERLAP",
      ]),
    ).toBeNull();
  });
});

describe("rightsCheck", () => {
  const scope: Scope = {
    workspaceId: "00000000-0000-4000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000002",
    userId: "user",
    role: "editor",
  };
  const ids = new Map<string, string>();
  /** A uuid per readable name, so the test reads like the reasons. */
  const idOf = (name: string) => {
    if (!ids.has(name)) ids.set(name, randomUUID());
    return ids.get(name)!;
  };
  const asset = (name: string, data: Record<string, unknown>) =>
    ({
      id: idOf(name),
      version: 1,
      kind: "assets",
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      data: {
        usageApproved: true,
        assetStatus: "approved",
        validUses: ["brand", "social"],
        sha256: "a".repeat(64),
        ...data,
      },
    }) as unknown as EntityRow;
  /** A transaction that answers with the rows stored now, filtered like the database. */
  const txWith = (stored: EntityRow[]) => {
    const queries: unknown[] = [];
    const tx = {
      entity: {
        findMany: async (query: { where: Record<string, any> }) => {
          queries.push(query.where);
          return stored.filter(
            (row) =>
              query.where.id.in.includes(row.id) &&
              row.projectId === query.where.projectId &&
              row.workspaceId === query.where.workspaceId &&
              query.where.kind === "assets",
          );
        },
      },
    } as unknown as DbTx;
    return { tx, queries };
  };

  it("passes approved, unbound components approved for the use", async () => {
    const rows = [asset("a", {}), asset("b", { type: "logo" })];
    expect(await rightsCheck(txWith(rows).tx, scope, rows, "social")).toEqual({
      code: "ASSET_RIGHTS",
      passed: true,
      severity: "blocker",
    });
  });

  it("judges the components as stored now and lists every refused one", async () => {
    const planned = [
      asset("ok", {}),
      asset("unapproved", {}),
      asset("bound", {}),
      asset("blog", {}),
      asset("gone", {}),
    ];
    const stored = [
      asset("ok", {}),
      // Approved when planned, its approval taken back since.
      asset("unapproved", { assetStatus: "reference", usageApproved: false }),
      asset("bound", { boundTo: { creativeId: "c", contentId: "x" } }),
      asset("blog", { validUses: ["blog"] }),
    ];
    const { tx, queries } = txWith(stored);
    const check = await rightsCheck(tx, scope, planned, "social");
    expect(check).toMatchObject({
      code: "ASSET_RIGHTS",
      passed: false,
      severity: "blocker",
      detail: {
        assetIds: ["unapproved", "bound", "blog", "gone"].map(idOf).join(","),
        reasons: "not_approved,bound,use_not_approved,not_found",
      },
    });
    // Read in this project only.
    expect(queries).toEqual([
      expect.objectContaining({
        projectId: scope.projectId,
        workspaceId: scope.workspaceId,
        kind: "assets",
      }),
    ]);
  });

  it("refuses a component without any recorded use", async () => {
    const rows = [asset("old", { validUses: undefined })];
    expect(
      (await rightsCheck(txWith(rows).tx, scope, rows, "social")).passed,
    ).toBe(false);
  });

  it("refuses a component whose bytes carry no SHA-256", async () => {
    const rows = [
      asset("unhashed", { sha256: undefined }),
      asset("short", { sha256: "abc" }),
    ];
    expect(
      await rightsCheck(txWith(rows).tx, scope, rows, "social"),
    ).toMatchObject({
      passed: false,
      detail: {
        assetIds: ["unhashed", "short"].map(idOf).join(","),
        reasons: "no_sha256,no_sha256",
      },
    });
  });
});
