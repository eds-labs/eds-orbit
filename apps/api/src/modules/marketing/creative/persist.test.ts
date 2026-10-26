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
} as unknown as CreativePlan;

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
});
