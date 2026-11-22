import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; kind: string; version: number; data: Record<string, any> };

const state = vi.hoisted(() => ({
  rows: [] as Row[],
  flag: "true",
  // What the next refresh does: succeed, get rejected (recorded) or fail briefly.
  refresh: "ok" as "ok" | "rejected" | "transient",
  refreshCalls: 0,
  driveFiles: {} as Record<string, { bytes: Buffer; mime: string; md5: string }>,
  notices: [] as Array<{ kind: string; body: string; link: string }>,
  telegram: [] as Array<{ kind: string; ref: string }>,
  audits: [] as string[],
}));

vi.mock("../../../../../../packages/db/src/index.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scoped: async (_w: string, _p: string, fn: (tx: any) => Promise<unknown>) =>
    fn({
      project: {
        findFirstOrThrow: async () => ({ language: "de" }),
        findUniqueOrThrow: async () => ({ timezone: "Europe/Berlin" }),
      },
      entity: {
        findMany: async ({ where }: any) =>
          state.rows.filter(
            (r) =>
              r.kind === where.kind &&
              (!where.data || r.data[where.data.path[0]] === where.data.equals),
          ),
        findFirst: async ({ where }: any) =>
          state.rows.find((r) => r.id === where.id && r.kind === where.kind) ?? null,
      },
    }),
}));
vi.mock("../../../../../../packages/config/src/index.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadConfig: () => ({ ORBIT_DRIVE_WATCH: state.flag, APP_ORIGIN: "https://orbit.example" }),
}));
vi.mock("../../../shared.ts", async (importOriginal) => {
  const real = await importOriginal<any>();
  return {
    ...real,
    list: async (_tx: unknown, _s: unknown, kind: string) =>
      state.rows.filter((r) => r.kind === kind),
    create: async (_tx: unknown, _s: unknown, kind: string, value: any) => {
      const row = { id: randomUUID(), kind, version: 1, data: JSON.parse(JSON.stringify(value)) };
      state.rows.push(row);
      return row;
    },
    update: async (_tx: unknown, _s: unknown, row: Row, value: any) => {
      const found = state.rows.find((r) => r.id === row.id)!;
      found.data = JSON.parse(JSON.stringify(value));
      found.version += 1;
      return found;
    },
    audit: async (_tx: unknown, _s: unknown, action: string) => {
      state.audits.push(action);
    },
  };
});
vi.mock("../../../platform/connections/google-drive.ts", async (importOriginal) => {
  const real = await importOriginal<object>();
  const { DomainError } = await import("../../../platform/shared.ts");
  const connection = () => state.rows.find((r) => r.kind === "drive_connection");
  return {
    ...real,
    projectDriveRow: async (_tx: unknown, _s: unknown, kind: string) =>
      state.rows.find((r) => r.kind === kind) ?? null,
    driveReconnectRequired: (row: Row | null | undefined) =>
      Boolean(row?.data.encryptedRefreshToken && row?.data.lastRefreshFailedAt),
    driveAccessToken: async () => {
      state.refreshCalls += 1;
      if (state.refresh === "rejected") {
        connection()!.data.lastRefreshFailedAt = new Date().toISOString();
        connection()!.data.lastRefreshErrorCode = "invalid_grant";
      }
      if (state.refresh !== "ok") throw new DomainError("GOOGLE_DRIVE_OAUTH_FAILED", 502);
      return "token";
    },
    driveContent: async (_s: unknown, fileId: string, expected?: { md5Checksum?: string }) => {
      if (connection()?.data.lastRefreshFailedAt)
        throw new DomainError("GOOGLE_DRIVE_OAUTH_FAILED", 502);
      const file = state.driveFiles[fileId];
      if (!file) throw new DomainError("GOOGLE_DRIVE_REQUEST_FAILED", 502);
      if (expected?.md5Checksum && expected.md5Checksum !== file.md5)
        throw new DomainError("DRIVE_ASSET_CHANGED", 409);
      return { bytes: file.bytes, mime: file.mime, name: fileId };
    },
  };
});
vi.mock("../../../platform/notifications/members.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  notifyMembers: async (_tx: unknown, _s: unknown, notice: any) => {
    state.notices.push(notice);
    return { inApp: 1, email: 0 };
  },
}));
vi.mock("../../../platform/signals/deliver.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveRecipients: async () => ["owner-1"],
}));
vi.mock("../../../platform/modules/contributions.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  registeredUserNotification: (kind: string) => ({ label: { de: kind, en: kind } }),
}));
vi.mock("../agents/notifications.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  notify: async (_tx: unknown, _s: unknown, kind: string, ref: string) => {
    state.telegram.push({ kind, ref });
  },
}));

import { scoped } from "../../../../../../packages/db/src/index.ts";
import { marketingNotifications } from "../agents/notification-messages.ts";
import {
  DRIVE_WATCH_INTERVAL_MS,
  driveCheckDue,
  driveWatchTransition,
  keepLocalCopies,
  LOCAL_COPY_RETRY_MS,
  needsLocalCopy,
  nextDriveWatchAt,
  resetDriveWatchThrottle,
  runDriveWatch,
} from "./drive-watch.ts";

const scope = {
  workspaceId: "344c4949-08c0-472a-9bd4-8e49e5c76e72",
  projectId: "53f7ca69-4e6b-48ca-b15e-bf95b73ea691",
  userId: "worker",
  role: "owner" as const,
};
const add = (kind: string, data: Record<string, any>) => {
  const row = { id: randomUUID(), kind, version: 1, data };
  state.rows.push(row);
  return row;
};
const watch = () => state.rows.find((r) => r.kind === "drive_watch")?.data;
const at = (iso: string) => new Date(iso);
const png = Buffer.from("89504e470d0a1a0a0000", "hex");
const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex");
const approvedDriveImage = (extra: Record<string, any> = {}) => ({
  name: "logo.png",
  type: "logo",
  mime: "image/png",
  bytes: png.length,
  driveFileId: "file1",
  md5Checksum: md5(png),
  usageApproved: true,
  assetStatus: "approved",
  ...extra,
});

beforeEach(() => {
  state.rows = [];
  state.flag = "true";
  state.refresh = "ok";
  state.refreshCalls = 0;
  state.driveFiles = { file1: { bytes: png, mime: "image/png", md5: md5(png) } };
  state.notices = [];
  state.telegram = [];
  state.audits = [];
  resetDriveWatchThrottle();
  add("drive_connection", { encryptedRefreshToken: "secret", account: "a@example.com" });
});

describe("drive watch decisions", () => {
  it("reports an outage once and the recovery once", () => {
    expect(driveWatchTransition(null, false)).toBeNull();
    expect(driveWatchTransition(null, true)).toBe("broken");
    expect(driveWatchTransition({ broken: true }, true)).toBeNull();
    expect(driveWatchTransition({ broken: true }, false)).toBe("recovered");
  });

  it("refreshes when never checked or after the interval", () => {
    const now = at("2026-11-19T12:00:00Z");
    expect(driveCheckDue(null, now)).toBe(true);
    expect(driveCheckDue({ lastCheckedAt: "2026-11-19T11:00:00Z" }, now)).toBe(false);
    expect(
      driveCheckDue({ lastCheckedAt: new Date(now.valueOf() - DRIVE_WATCH_INTERVAL_MS).toISOString() }, now),
    ).toBe(true);
  });

  it("copies only approved, pinned, Drive-only raster images", () => {
    const now = at("2026-11-19T12:00:00Z");
    expect(needsLocalCopy(approvedDriveImage(), now)).toBe(true);
    expect(needsLocalCopy(approvedDriveImage({ base64: "AA==" }), now)).toBe(false);
    expect(needsLocalCopy(approvedDriveImage({ md5Checksum: undefined }), now)).toBe(false);
    expect(needsLocalCopy(approvedDriveImage({ usageApproved: false }), now)).toBe(false);
    expect(needsLocalCopy(approvedDriveImage({ mime: "image/svg+xml" }), now)).toBe(false);
    expect(needsLocalCopy(approvedDriveImage({ bytes: 6_000_000 }), now)).toBe(false);
    expect(
      needsLocalCopy(approvedDriveImage({ localCopyFailedAt: "2026-11-19T11:00:00Z" }), now),
    ).toBe(false);
    expect(
      needsLocalCopy(
        approvedDriveImage({ localCopyFailedAt: new Date(now.valueOf() - LOCAL_COPY_RETRY_MS).toISOString() }),
        now,
      ),
    ).toBe(true);
  });
});

describe("runDriveWatch", () => {
  it("does nothing with the flag off or without a connection", async () => {
    state.flag = "false";
    expect(await runDriveWatch(scope, at("2026-11-19T12:00:00Z"))).toBeUndefined();
    state.flag = "true";
    state.rows = [];
    expect(await runDriveWatch(scope, at("2026-11-19T12:00:00Z"))).toBeUndefined();
    expect(state.refreshCalls).toBe(0);
    expect(watch()).toBeUndefined();
  });

  it("refreshes a healthy connection, stays quiet and wakes at the next check", async () => {
    const now = at("2026-11-19T12:00:00Z");
    const result = await runDriveWatch(scope, now);
    expect(state.refreshCalls).toBe(1);
    expect(watch()).toMatchObject({ broken: false, lastCheckedAt: now.toISOString() });
    expect(state.notices).toEqual([]);
    expect(state.telegram).toEqual([]);
    expect(result).toEqual({ wakeAt: new Date(now.valueOf() + DRIVE_WATCH_INTERVAL_MS) });
  });

  it("warns once when Google rejects the refresh, and once when Drive works again", async () => {
    state.refresh = "rejected";
    const t1 = at("2026-11-19T12:00:00Z");
    await runDriveWatch(scope, t1);
    expect(watch()).toMatchObject({ broken: true, errorCode: "invalid_grant", brokenSince: t1.toISOString() });
    expect(state.notices.map((n) => n.kind)).toEqual(["marketing_drive_reconnect_required"]);
    expect(state.notices[0]!.body).toContain("invalid_grant");
    expect(state.notices[0]!.link).toBe(`/manage/p/${scope.projectId}/integrations/google-drive`);
    expect(state.telegram).toEqual([{ kind: "drive_reconnect", ref: `${scope.projectId}:${t1.toISOString()}` }]);
    expect(state.audits).toEqual(["drive.reconnect_required"]);

    // Later passes while broken: no new refresh, no second warning.
    resetDriveWatchThrottle();
    await runDriveWatch(scope, at("2026-11-20T12:00:00Z"));
    expect(state.refreshCalls).toBe(1);
    expect(state.notices).toHaveLength(1);
    expect(state.telegram).toHaveLength(1);

    // The owner reconnects (finishConnect writes a fresh connection record).
    const connection = state.rows.find((r) => r.kind === "drive_connection")!;
    connection.data = { encryptedRefreshToken: "new-secret", account: "a@example.com" };
    state.refresh = "ok";
    resetDriveWatchThrottle();
    const t3 = at("2026-11-20T13:00:00Z");
    await runDriveWatch(scope, t3);
    expect(watch()).toMatchObject({ broken: false, errorCode: null, recoveredAt: t3.toISOString() });
    expect(state.notices.map((n) => n.kind)).toEqual([
      "marketing_drive_reconnect_required",
      "marketing_drive_reconnected",
    ]);
    expect(state.telegram.map((t) => t.kind)).toEqual(["drive_reconnect", "drive_reconnected"]);
  });

  it("reports a failure another Drive call recorded without calling Google", async () => {
    const connection = state.rows.find((r) => r.kind === "drive_connection")!;
    connection.data.lastRefreshFailedAt = "2026-11-18T07:02:13Z";
    connection.data.lastRefreshErrorCode = "invalid_grant";
    await runDriveWatch(scope, at("2026-11-19T12:00:00Z"));
    expect(state.refreshCalls).toBe(0);
    expect(watch()).toMatchObject({ broken: true, errorCode: "invalid_grant" });
    expect(state.telegram.map((t) => t.kind)).toEqual(["drive_reconnect"]);
  });

  it("does not treat a brief Google error as an outage", async () => {
    state.refresh = "transient";
    await runDriveWatch(scope, at("2026-11-19T12:00:00Z"));
    expect(state.refreshCalls).toBe(1);
    expect(watch()).toMatchObject({ broken: false });
    expect(state.notices).toEqual([]);
  });

  it("reads the recorded state at most every few minutes per project", async () => {
    await runDriveWatch(scope, at("2026-11-19T12:00:00Z"));
    const version = state.rows.find((r) => r.kind === "drive_watch")!.version;
    await runDriveWatch(scope, at("2026-11-19T12:01:00Z"));
    expect(state.rows.find((r) => r.kind === "drive_watch")!.version).toBe(version);
  });

  it("keeps a local copy of an approved Drive-only image while Drive works", async () => {
    const asset = add("assets", approvedDriveImage());
    await runDriveWatch(scope, at("2026-11-19T12:00:00Z"));
    expect(asset.data).toMatchObject({
      base64: png.toString("base64"),
      sha256: createHash("sha256").update(png).digest("hex"),
      localCopySource: "drive",
      localCopyAt: "2026-11-19T12:00:00.000Z",
    });
  });

  it("makes copies only with a live check, not on every pass", async () => {
    await runDriveWatch(scope, at("2026-11-19T12:00:00Z"));
    const asset = add("assets", approvedDriveImage());
    resetDriveWatchThrottle();
    await runDriveWatch(scope, at("2026-11-19T13:00:00Z"));
    expect(asset.data.base64).toBeUndefined();
    resetDriveWatchThrottle();
    await runDriveWatch(scope, at("2026-11-19T18:00:00Z"));
    expect(asset.data.localCopySource).toBe("drive");
  });

  it("makes no copy while Drive is broken", async () => {
    state.refresh = "rejected";
    const asset = add("assets", approvedDriveImage());
    await runDriveWatch(scope, at("2026-11-19T12:00:00Z"));
    expect(asset.data.base64).toBeUndefined();
    expect(asset.data.localCopyFailedAt).toBeUndefined();
  });
});

describe("keepLocalCopies", () => {
  it("refuses bytes that are not the approved version and retries a day later", async () => {
    const asset = add("assets", approvedDriveImage());
    state.driveFiles.file1 = { bytes: Buffer.from("changed"), mime: "image/png", md5: "other" };
    const now = at("2026-11-19T12:00:00Z");
    expect(await keepLocalCopies(scope, now)).toBe(0);
    expect(asset.data.base64).toBeUndefined();
    expect(asset.data.localCopyFailedAt).toBe(now.toISOString());
  });

  it("refuses bytes whose checksum does not match although Drive reports it", async () => {
    const asset = add("assets", approvedDriveImage());
    state.driveFiles.file1 = { bytes: Buffer.from("tampered"), mime: "image/png", md5: md5(png) };
    expect(await keepLocalCopies(scope, at("2026-11-19T12:00:00Z"))).toBe(0);
    expect(asset.data.base64).toBeUndefined();
  });

  it("copies at most the per-pass limit", async () => {
    for (let i = 0; i < 7; i += 1) add("assets", approvedDriveImage());
    expect(await keepLocalCopies(scope, at("2026-11-19T12:00:00Z"))).toBe(5);
  });
});

describe("nextDriveWatchAt", () => {
  it("is due now when never checked, then after the interval, never while broken", async () => {
    const before = Date.now();
    expect((await nextDriveWatchAt({} as any, scope))!.valueOf()).toBeGreaterThanOrEqual(before);
    add("drive_watch", { lastCheckedAt: "2026-11-19T12:00:00.000Z", broken: false });
    expect(await nextDriveWatchAt({} as any, scope)).toEqual(
      new Date(Date.parse("2026-11-19T12:00:00Z") + DRIVE_WATCH_INTERVAL_MS),
    );
    state.rows.find((r) => r.kind === "drive_connection")!.data.lastRefreshFailedAt = "x";
    expect(await nextDriveWatchAt({} as any, scope)).toBeNull();
    state.flag = "false";
    expect(await nextDriveWatchAt({} as any, scope)).toBeNull();
  });
});

describe("Telegram message of the Drive watch", () => {
  const render = (kind: string, ref: string) =>
    scoped(scope.workspaceId, scope.projectId, (tx: any) =>
      marketingNotifications.render(tx, scope as any, kind, ref),
    ) as Promise<any>;

  it("names the outage while it lasts and is stale once Drive works again", async () => {
    state.refresh = "rejected";
    await runDriveWatch(scope, at("2026-11-19T12:00:00Z"));
    const outage = state.telegram[0]!.ref;
    const message = await render("drive_reconnect", outage);
    expect(message.skip).toBeUndefined();
    expect(message.text).toContain("Google Drive getrennt");
    expect(message.text).toContain("invalid_grant");
    expect(await render("drive_reconnected", outage)).toEqual({ skip: "STALE" });

    state.rows.find((r) => r.kind === "drive_connection")!.data = { encryptedRefreshToken: "new" };
    state.refresh = "ok";
    resetDriveWatchThrottle();
    await runDriveWatch(scope, at("2026-11-19T13:00:00Z"));
    const recovery = state.telegram[1]!.ref;
    expect(await render("drive_reconnect", outage)).toEqual({ skip: "STALE" });
    expect((await render("drive_reconnected", recovery)).text).toContain("wieder verbunden");
  });
});
