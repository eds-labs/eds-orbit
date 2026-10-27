import { describe, expect, it } from "vitest";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { renditionComponentsHold } from "./rendition-rights.ts";

const scope = { workspaceId: "w", projectId: "p" } as Scope;
const SHA_LOGO = "a".repeat(64);
const SHA_ART = "b".repeat(64);
const approved = (sha256: string, extra: Record<string, unknown> = {}) => ({
  usageApproved: true,
  assetStatus: "approved",
  sha256,
  ...extra,
});

/** A transaction whose asset rows are `rows`, by id (data as stored). */
const txWith = (rows: Record<string, Record<string, unknown>>) =>
  ({
    entity: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in
          .filter((id) => rows[id])
          .map((id) => ({ id, version: 7, data: rows[id] })),
    },
  }) as unknown as DbTx;

const rendition = (components: unknown) => ({
  boundTo: { creativeId: "c1", contentId: "p1" },
  rightsSource: { profileVersion: 1, components },
});
const logo = {
  role: "logo",
  logoRole: "primary",
  assetId: "logo-1",
  version: 2,
  sha256: SHA_LOGO,
};
const art = { role: "art", assetId: "art-1", version: 5, sha256: SHA_ART };

describe("rendition components", () => {
  it("hold while every component is approved with its recorded bytes", async () => {
    const tx = txWith({
      "logo-1": approved(SHA_LOGO),
      "art-1": approved(SHA_ART),
    });
    expect(
      await renditionComponentsHold(tx, scope, rendition([logo, art])),
    ).toBe(true);
  });

  it("ignore a new version of a component with the same bytes, and the case of the hash", async () => {
    const tx = txWith({
      "logo-1": approved(SHA_LOGO.toUpperCase()),
      "art-1": approved(SHA_ART),
    });
    expect(
      await renditionComponentsHold(tx, scope, rendition([logo, art])),
    ).toBe(true);
  });

  it.each([
    [
      "taken back to reference",
      { assetStatus: "reference", usageApproved: false },
    ],
    ["outdated", { assetStatus: "outdated", usageApproved: false }],
    ["without confirmed usage", { usageApproved: false }],
  ])("do not hold when a component is %s", async (_label, changes) => {
    const tx = txWith({
      "logo-1": approved(SHA_LOGO, changes),
      "art-1": approved(SHA_ART),
    });
    expect(
      await renditionComponentsHold(tx, scope, rendition([logo, art])),
    ).toBe(false);
  });

  it("do not hold when a component has other bytes or is gone", async () => {
    expect(
      await renditionComponentsHold(
        txWith({
          "logo-1": approved("c".repeat(64)),
          "art-1": approved(SHA_ART),
        }),
        scope,
        rendition([logo, art]),
      ),
    ).toBe(false);
    expect(
      await renditionComponentsHold(
        txWith({ "logo-1": approved(SHA_LOGO) }),
        scope,
        rendition([logo, art]),
      ),
    ).toBe(false);
  });

  it("cannot be shown to hold without recorded components or hashes", async () => {
    const tx = txWith({ "logo-1": approved(SHA_LOGO) });
    for (const components of [
      undefined,
      [],
      [{ ...logo, sha256: undefined }],
      [{ ...logo, sha256: "" }],
      [{ ...logo, assetId: undefined }],
      ["logo-1"],
    ])
      expect(
        await renditionComponentsHold(tx, scope, rendition(components)),
      ).toBe(false);
    expect(await renditionComponentsHold(tx, scope, {})).toBe(false);
  });
});
