import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { encrypt, data } from "../shared.ts";

const state = vi.hoisted(() => ({
  rows: [] as any[],
  fetchCalls: [] as string[],
  driveFiles: {} as Record<string, any>,
  failUpload: false,
}));
vi.mock("../../../../packages/db/src/index.ts", () => ({
  scoped: async (
    _workspaceId: string,
    _projectId: string,
    fn: (tx: any) => Promise<unknown>,
  ) => fn(tx),
}));
vi.mock("../../../../packages/config/src/index.ts", () => ({
  loadConfig: () => ({
    GOOGLE_DRIVE_CLIENT_ID: "test-client",
    GOOGLE_DRIVE_CLIENT_SECRET: "test-secret",
    CREDENTIAL_KEY: "a".repeat(64),
    APP_ORIGIN: "http://localhost:4310",
  }),
}));
const tx = {
  entity: {
    findMany: async ({ where }: any) =>
      state.rows.filter(
        (r) =>
          r.kind === where.kind &&
          r.workspaceId === where.workspaceId &&
          r.projectId === where.projectId,
      ),
    create: async ({ data }: any) => {
      const row = { ...data, id: randomUUID(), version: 1 };
      state.rows.push(row);
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      const row = state.rows.find(
        (r) => r.id === where.id && r.version === where.version,
      );
      if (!row) return { count: 0 };
      row.version += data.version.increment;
      row.data = data.data;
      return { count: 1 };
    },
    findUniqueOrThrow: async ({ where }: any) =>
      state.rows.find((r) => r.id === where.id) ??
      Promise.reject(new Error("missing")),
    delete: async ({ where }: any) => {
      state.rows = state.rows.filter((r) => r.id !== where.id);
    },
    findFirst: async ({ where }: any) =>
      state.rows.find(
        (r) =>
          r.id === where.id &&
          r.kind === where.kind &&
          r.workspaceId === where.workspaceId &&
          r.projectId === where.projectId,
      ) ?? null,
  },
  entityVersion: { create: async () => ({}) },
  project: { findUniqueOrThrow: async () => ({ name: "uLiquid" }) },
};
const scope = {
  workspaceId: "344c4949-08c0-472a-9bd4-8e49e5c76e72",
  projectId: "53f7ca69-4e6b-48ca-b15e-bf95b73ea691",
  userId: "synthetic-user",
  role: "owner" as const,
};
const root = "rootFolderABC123",
  outside = "foreignFolderABC123",
  logo = "logoFileABC123";
const files: Record<string, any> = {
  [root]: {
    id: root,
    name: "uLiquid",
    mimeType: "application/vnd.google-apps.folder",
    parents: ["root"],
  },
  [outside]: {
    id: outside,
    name: "foreign",
    mimeType: "application/vnd.google-apps.folder",
    parents: [],
  },
  [logo]: {
    id: logo,
    name: "logo.png",
    mimeType: "image/png",
    parents: [root],
    size: "8",
    md5Checksum: "known",
    modifiedTime: "2026-09-24T00:00:00Z",
  },
};
function add(kind: string, data: Record<string, unknown>) {
  state.rows.push({
    id: randomUUID(),
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    kind,
    data,
    version: 1,
  });
}
function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
import {
  beginConnect,
  browseDrive,
  configureRoot,
  connectionStatus,
  disconnect,
  driveContent,
  finishConnect,
  rootCandidates,
  saveGeneratedAsset,
  markSyncFailed,
  uploadUserRaster,
} from "./google-drive.ts";
import {
  encodeWebp,
  renderRasterTemplate,
} from "../../../../packages/creative/src/index.ts";

describe("Google Drive adapter with synthetic HTTP and scoped records", () => {
  beforeEach(() => {
    state.rows = [];
    state.fetchCalls = [];
    state.driveFiles = structuredClone(files);
    state.failUpload = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, options?: RequestInit) => {
        const address = String(url);
        state.fetchCalls.push(address);
        if (address.includes("oauth2.googleapis.com/token"))
          return json({
            access_token: "synthetic-access",
            refresh_token: "synthetic-refresh",
          });
        if (address.includes("/about?"))
          return json({ user: { emailAddress: "owner@example.invalid" } });
        if (address.includes("?alt=media"))
          return new Response(Buffer.from("pngbytes"));
        if (address.includes("/drive/v3/files/"))
          return state.driveFiles[address.split("/files/")[1]!.split("?")[0]!]
            ? json(
                state.driveFiles[address.split("/files/")[1]!.split("?")[0]!],
              )
            : new Response("missing", { status: 404 });
        if (address.includes("/upload/drive/v3/files?")) {
          if (state.failUpload) return new Response("failed", { status: 503 });
          const uploaded = {
            id: "uploadedFileABC123",
            name: "new.png",
            mimeType: "image/png",
            parents: [root],
          };
          state.driveFiles[uploaded.id] = uploaded;
          return json(uploaded);
        }
        if (
          address.includes("/drive/v3/files?") &&
          options?.method === "POST"
        ) {
          const body = JSON.parse(String(options.body));
          const created = {
            ...body,
            id: `createdFolder${Object.keys(state.driveFiles).length}ABC123`,
          };
          state.driveFiles[created.id] = created;
          return json(created);
        }
        if (address.includes("/drive/v3/files?")) {
          const q = new URL(address).searchParams.get("q") ?? "";
          const parent = q.match(/'([^']+)' in parents/)?.[1];
          return json({
            files: Object.values(state.driveFiles).filter(
              (f: any) =>
                f.parents?.includes(parent) &&
                (!q.includes("name =") || q.includes(`name = '${f.name}'`)) &&
                (!q.includes("appProperties has") ||
                  f.appProperties?.orbitAssetId),
            ),
          });
        }
        throw new Error(`unexpected synthetic URL ${address}`);
      }),
    );
  });
  it("creates a bound OAuth state and encrypts the refresh token after callback", async () => {
    const { url } = await beginConnect(scope);
    const stateValue = new URL(url).searchParams.get("state")!;
    expect(stateValue.startsWith(scope.projectId)).toBe(true);
    await finishConnect(scope, stateValue, "synthetic-code");
    expect((await connectionStatus(scope)).account).toBe(
      "owner@example.invalid",
    );
    expect(JSON.stringify(state.rows)).not.toContain("synthetic-refresh");
    expect((await connectionStatus(scope)).enabled).toBe(true);
    expect((await connectionStatus(scope)).rootFolderId).toBe(root);
    await expect(
      finishConnect(scope, stateValue, "replay"),
    ).rejects.toMatchObject({ code: "GOOGLE_DRIVE_OAUTH_STATE_INVALID" });
    await disconnect(scope);
    expect((await connectionStatus(scope)).connected).toBe(false);
  });
  it("does not choose an ambiguous matching project folder", async () => {
    state.driveFiles.duplicateFolderABC123 = {
      id: "duplicateFolderABC123",
      name: "uLiquid",
      mimeType: "application/vnd.google-apps.folder",
      parents: ["root"],
    };
    const { url } = await beginConnect(scope);
    const ready = await finishConnect(
      scope,
      new URL(url).searchParams.get("state")!,
      "synthetic-code",
    );
    expect(ready).toBe(false);
    expect((await connectionStatus(scope)).connected).toBe(true);
    expect((await connectionStatus(scope)).enabled).toBe(false);
    expect((await rootCandidates(scope)).folders).toEqual(
      expect.arrayContaining([
        { id: root, name: "uLiquid" },
        { id: "duplicateFolderABC123", name: "uLiquid" },
      ]),
    );
  });
  it("discovers the existing brand folders under the selected root", async () => {
    state.driveFiles.brandParentABC123 = {
      id: "brandParentABC123",
      name: "01_Marke_und_Design",
      mimeType: "application/vnd.google-apps.folder",
      parents: [root],
    };
    state.driveFiles.brandLogosABC123 = {
      id: "brandLogosABC123",
      name: "01_Logos",
      mimeType: "application/vnd.google-apps.folder",
      parents: ["brandParentABC123"],
    };
    state.driveFiles.brandImagesABC123 = {
      id: "brandImagesABC123",
      name: "03_Bildwelt",
      mimeType: "application/vnd.google-apps.folder",
      parents: ["brandParentABC123"],
    };
    const { url } = await beginConnect(scope);
    expect(
      await finishConnect(
        scope,
        new URL(url).searchParams.get("state")!,
        "synthetic-code",
      ),
    ).toBe(true);
    expect(await connectionStatus(scope)).toMatchObject({
      brandLogoFolderId: "brandLogosABC123",
      brandImagesFolderId: "brandImagesABC123",
    });
  });
  it("lists only descendants of the configured project root", async () => {
    add("drive_connection", {
      encryptedRefreshToken: encrypt("synthetic-refresh", "a".repeat(64)),
    });
    await configureRoot(scope, { rootFolderId: root });
    expect((await browseDrive(scope, {})).files.map((f) => f.id)).toEqual([
      logo,
    ]);
    await expect(
      browseDrive(scope, { folderId: outside }),
    ).rejects.toMatchObject({ code: "GOOGLE_DRIVE_FOLDER_OUTSIDE_ROOT" });
  });
  it("uploads a generated PNG once and preserves the asset for retry after a Drive failure", async () => {
    add("drive_connection", {
      encryptedRefreshToken: encrypt("synthetic-refresh", "a".repeat(64)),
    });
    add("drive_storage", { rootFolderId: root, enabled: true });
    const assetId = randomUUID();
    state.rows.push({
      id: assetId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "assets",
      version: 1,
      data: {
        name: "test artwork",
        type: "generated_artwork",
        mime: "image/png",
        base64: Buffer.from("pngbytes").toString("base64"),
        driveSyncStatus: "PENDING",
      },
    });
    state.failUpload = true;
    await expect(saveGeneratedAsset(scope, assetId)).rejects.toMatchObject({
      code: "GOOGLE_DRIVE_REQUEST_FAILED",
    });
    expect(data(await markSyncFailed(scope, assetId)).driveSyncStatus).toBe(
      "FAILED",
    );
    state.failUpload = false;
    const saved = await saveGeneratedAsset(scope, assetId);
    expect(data(saved).driveFileId).toBe("uploadedFileABC123");
    expect(data(saved).driveSyncStatus).toBe("SYNCED");
    await saveGeneratedAsset(scope, assetId);
    expect(
      state.fetchCalls.filter((url) => url.includes("upload/drive/v3/files"))
        .length,
    ).toBe(2);
  });
  it("uploads validated PNG and WebP as private Drive files", async () => {
    add("drive_connection", {
      encryptedRefreshToken: encrypt("synthetic-refresh", "a".repeat(64)),
    });
    add("drive_storage", { rootFolderId: root, enabled: true });
    const rendered = await renderRasterTemplate({
      format: "square",
      title: "Synthetic",
      logoApproved: true,
    });
    if (rendered.status !== "rendered")
      throw new Error("synthetic render blocked");
    const png = rendered.bytes;
    const webp = await encodeWebp(png);
    for (const [mime, bytes] of [
      ["image/png", png],
      ["image/webp", webp],
    ] as const) {
      const result = await uploadUserRaster(scope, {
        name: `Synthetic ${mime}`,
        type: "logo",
        mime,
        base64: bytes.toString("base64"),
        source: "Synthetic",
        license: "Synthetic rights",
        validUses: ["brand"],
        confirmRightsInformation: true,
      });
      expect(data(result).mime).toBe(mime);
      expect(data(result).driveFileId).toBe("uploadedFileABC123");
      expect(data(result).usageApproved).toBe(false);
    }
    await expect(
      uploadUserRaster(scope, {
        name: "Foreign",
        type: "logo",
        mime: "image/png",
        base64: png.toString("base64"),
        source: "Synthetic",
        license: "Synthetic rights",
        validUses: ["brand"],
        confirmRightsInformation: true,
        folderId: outside,
      }),
    ).rejects.toMatchObject({ code: "GOOGLE_DRIVE_FOLDER_OUTSIDE_ROOT" });
    expect(
      state.fetchCalls.filter((url) => url.includes("upload/drive/v3/files"))
        .length,
    ).toBe(2);
  });
  it("checks an approved file version before returning bytes", async () => {
    add("drive_connection", {
      encryptedRefreshToken: encrypt("synthetic-refresh", "a".repeat(64)),
    });
    add("drive_storage", { rootFolderId: root, enabled: true });
    expect(
      (
        await driveContent(scope, logo, { md5Checksum: "known" })
      ).bytes.toString(),
    ).toBe("pngbytes");
    await expect(
      driveContent(scope, logo, { md5Checksum: "changed" }),
    ).rejects.toMatchObject({ code: "DRIVE_ASSET_CHANGED" });
    await expect(driveContent(scope, outside)).rejects.toMatchObject({
      code: "GOOGLE_DRIVE_FILE_OUTSIDE_ROOT",
    });
  });
});
