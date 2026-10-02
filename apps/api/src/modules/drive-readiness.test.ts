import { describe, expect, it } from "vitest";
import {
  driveReconnectRequired,
  publishingUsesDriveAssets,
} from "./drive-readiness.ts";

const scope = {
  workspaceId: "344c4949-08c0-472a-9bd4-8e49e5c76e72",
  projectId: "53f7ca69-4e6b-48ca-b15e-bf95b73ea691",
  userId: "synthetic-user",
  role: "owner" as const,
};
const driveOnly = "11111111-1111-4111-8111-111111111111",
  inline = "22222222-2222-4222-8222-222222222222",
  foreign = "33333333-3333-4333-8333-333333333333";

function fakeTx(rows: { id?: string; kind: string; data: unknown }[]) {
  const all = rows.map((row, index) => ({
    id: row.id ?? `row-${index}`,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    ...row,
  }));
  // A foreign project's Drive-only asset must never count.
  all.push({
    id: foreign,
    workspaceId: scope.workspaceId,
    projectId: "other-project",
    kind: "assets",
    data: { driveFileId: "driveFileABC123" },
  });
  return {
    entity: {
      findMany: async ({ where }: any) =>
        all.filter(
          (r) =>
            r.kind === where.kind &&
            r.workspaceId === where.workspaceId &&
            r.projectId === where.projectId &&
            (!where.id || where.id.in.includes(r.id)),
        ),
    },
  } as any;
}
const assets = [
  { id: driveOnly, kind: "assets", data: { driveFileId: "driveFileABC123" } },
  {
    id: inline,
    kind: "assets",
    data: { driveFileId: "driveFileDEF456", base64: "cG5n" },
  },
];

describe("Drive readiness from recorded state", () => {
  it("requires a reconnect only for a stored token with a recorded failure", () => {
    expect(driveReconnectRequired(null)).toBe(false);
    expect(
      driveReconnectRequired({ data: { encryptedRefreshToken: "enc" } }),
    ).toBe(false);
    expect(
      driveReconnectRequired({
        data: { lastRefreshFailedAt: "2026-10-01T08:00:00.000Z" },
      }),
    ).toBe(false);
    expect(
      driveReconnectRequired({
        data: {
          encryptedRefreshToken: "enc",
          lastRefreshFailedAt: "2026-10-01T08:00:00.000Z",
        },
      }),
    ).toBe(true);
  });

  it("detects Drive-only assets in enabled autopilot settings", async () => {
    const settings = (enabled: boolean, assetIds: string[]) =>
      fakeTx([
        ...assets,
        { kind: "autopilot_settings", data: { enabled, assetIds } },
      ]);
    expect(
      await publishingUsesDriveAssets(settings(true, [driveOnly]), scope),
    ).toBe(true);
    expect(
      await publishingUsesDriveAssets(settings(false, [driveOnly]), scope),
    ).toBe(false);
    // Assets with inline bytes are published without reading Drive.
    expect(
      await publishingUsesDriveAssets(settings(true, [inline]), scope),
    ).toBe(false);
    expect(
      await publishingUsesDriveAssets(settings(true, [foreign]), scope),
    ).toBe(false);
  });

  it("detects Drive-only assets in running missions only", async () => {
    const mission = (status: string) =>
      fakeTx([
        ...assets,
        { kind: "missions", data: { status, assetIds: [driveOnly] } },
      ]);
    expect(await publishingUsesDriveAssets(mission("ready"), scope)).toBe(true);
    expect(
      await publishingUsesDriveAssets(mission("awaiting_followup"), scope),
    ).toBe(true);
    expect(await publishingUsesDriveAssets(mission("completed"), scope)).toBe(
      false,
    );
    expect(await publishingUsesDriveAssets(fakeTx(assets), scope)).toBe(false);
  });
});
