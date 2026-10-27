import { describe, expect, it } from "vitest";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  composedFields,
  saveRenditions,
  type ComposedCreative,
  type CreativePlan,
} from "./persist.ts";

const scope: Scope = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  userId: "00000000-0000-4000-8000-000000000003",
  role: "owner",
};

/** A composition whose returned attempt carries `failed`. */
const composedWith = (failed: string[]) =>
  ({
    outcome: {
      renditions: [
        {
          format: "square",
          variant: "text_bottom",
          textScale: "m",
          result: { logoRole: "primary", layers: [], png: Buffer.alloc(0) },
          checks: [],
        },
      ],
      overflow: [],
      checks: [],
      failed,
      corrections: [],
      artCorrection: null,
      verdict: "needs_owner",
    },
    products: [],
  }) as unknown as ComposedCreative;
const plan = {
  kit: {
    profileVersion: 1,
    logos: { primary: { id: "logo", version: 1, data: { sha256: "a" } } },
  },
  brief: { template: "lifestyle" },
  art: null,
  products: [],
  rights: { code: "ASSET_RIGHTS", passed: true, severity: "blocker" },
} as unknown as CreativePlan;
/** A transaction that records the data of the assets created. */
const recording = () => {
  const created: Array<Record<string, any>> = [];
  const tx = {
    entity: {
      create: async (args: { data: { data: Record<string, any> } }) => {
        created.push(args.data.data);
        return { id: `asset-${created.length}`, version: 1, ...args.data };
      },
    },
    entityVersion: { create: async () => undefined },
  } as unknown as DbTx;
  return { tx, created };
};
const renditionInput = (p: CreativePlan, composed: ComposedCreative) => ({
  creativeId: "creative",
  contentId: "content",
  title: "A post",
  plan: p,
  composed,
  approvedBy: scope.userId,
});

describe("refusals in the shared blocks (R34, R42)", () => {
  it("stores no rendition of a refused creative, whoever calls", async () => {
    const created: unknown[] = [];
    const tx = {
      entity: { create: async (row: unknown) => created.push(row) },
      entityVersion: { create: async () => undefined },
    } as unknown as DbTx;
    for (const code of [
      "LOGO_INTEGRITY",
      "SCREENSHOT_INTEGRITY",
      "ASSET_RIGHTS",
    ]) {
      await expect(
        saveRenditions(tx, scope, {
          creativeId: "creative",
          contentId: "content",
          title: "A post",
          plan,
          composed: composedWith(["EMPTY_AREA_EXCESSIVE", code]),
          approvedBy: scope.userId,
        }),
      ).rejects.toMatchObject({ code, status: 409 });
      expect(() =>
        composedFields(plan, composedWith([code, "TEXT_CONTRAST_LOW"])),
      ).toThrow(code);
    }
    expect(created).toEqual([]);
  });

  it("records other findings for the owner", () => {
    expect(
      composedFields(plan, composedWith(["EMPTY_AREA_EXCESSIVE"])).status,
    ).toBe("needs_owner");
  });

  it("refuses a plan whose rights check failed, whoever skipped checkedPlan (R46)", async () => {
    const { tx, created } = recording();
    const failed = {
      ...plan,
      rights: {
        code: "ASSET_RIGHTS",
        passed: false,
        severity: "blocker",
        detail: { assetIds: "art", reasons: "not_approved" },
      },
    } as CreativePlan;
    await expect(
      saveRenditions(tx, scope, renditionInput(failed, composedWith([]))),
    ).rejects.toMatchObject({
      code: "ASSET_RIGHTS",
      status: 409,
      detail: { assetIds: "art", reasons: "not_approved" },
    });
    expect(() => composedFields(failed, composedWith([]))).toThrow(
      "ASSET_RIGHTS",
    );
    expect(created).toEqual([]);
  });
});

describe("new art awaiting the owner's rights decision", () => {
  const pending = {
    ...plan,
    rights: {
      code: "ASSET_RIGHTS",
      passed: true,
      severity: "blocker",
      detail: { pendingAssetIds: "art" },
    },
  } as CreativePlan;

  it("stores the renditions as unapproved references and the creative as needs_rights", async () => {
    const { tx, created } = recording();
    await saveRenditions(tx, scope, renditionInput(pending, composedWith([])));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      usageApproved: false,
      assetStatus: "reference",
    });
    expect(created[0]!.approvedBy).toBeUndefined();
    expect(composedFields(pending, composedWith([])).status).toBe(
      "needs_rights",
    );
    // Findings stay in the QA; the rights decision comes first.
    expect(
      composedFields(pending, composedWith(["EMPTY_AREA_EXCESSIVE"])).status,
    ).toBe("needs_rights");
  });

  it("approves the renditions of approved components", async () => {
    const { tx, created } = recording();
    await saveRenditions(tx, scope, renditionInput(plan, composedWith([])));
    expect(created[0]).toMatchObject({
      usageApproved: true,
      assetStatus: "approved",
      approvedBy: scope.userId,
    });
  });
});
