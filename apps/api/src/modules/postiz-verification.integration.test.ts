import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import {
  authDb,
  scoped,
  closeDatabase,
  type DbTx,
} from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { create, data, encrypt, entity, update } from "../shared.ts";
import {
  executePostizVerification,
  preparePostizVerification,
  reconcilePostizVerification,
} from "./postiz-verification.ts";
const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
describe.skipIf(!enabled)(
  "Owner-scoped Postiz proof with real database and injected provider",
  () => {
    let scope: Scope, workspaceId: string, userId: string, connectorId: string;
    const run = <T>(work: (tx: DbTx) => Promise<T>) =>
      scoped(scope.workspaceId, scope.projectId, work);
    beforeAll(async () => {
      userId = randomUUID();
      await authDb.user.create({
        data: {
          id: userId,
          email: userId + "@example.invalid",
          name: "Postiz verification fixture",
        },
      });
      workspaceId = (
        await authDb.workspace.create({
          data: {
            name: "Isolated Postiz verification",
            members: { create: { userId, role: "owner" } },
          },
        })
      ).id;
    });
    beforeEach(async () => {
      vi.stubEnv("PUBLISHER_INSTANCE_ID", "synthetic-postiz-instance");
      const project = await authDb.project.create({
        data: { workspaceId, name: "Postiz verification fixture" },
      });
      scope = { workspaceId, projectId: project.id, userId, role: "owner" };
      connectorId = (
        await run((tx) =>
          create(tx, scope, "connectors", {
            provider: "postiz",
            baseUrl: "https://postiz.example.invalid/public/v1",
            status: "read_verified",
            encryptedCredential: encrypt(
              "synthetic-no-live-token",
              process.env.CREDENTIAL_KEY!,
            ),
            channels: [
              {
                id: "account-one",
                identifier: "linkedin",
                name: "Sandbox account",
                disabled: false,
              },
              {
                id: "account-other",
                identifier: "linkedin",
                name: "Other account",
                disabled: false,
              },
            ],
          }),
        )
      ).id;
    });
    afterEach(() => vi.unstubAllEnvs());
    afterAll(async () => {
      if (workspaceId)
        await authDb.workspace.delete({ where: { id: workspaceId } });
      if (userId) await authDb.user.delete({ where: { id: userId } });
      await closeDatabase();
    });
    const prepare = () =>
      run((tx) =>
        preparePostizVerification(tx, scope, {
          connectorId,
          integrationId: "account-one",
          confirmSandboxAccount: true,
        }),
      );
    const approval = (v: { id: string; data: unknown }) => ({
      verificationId: v.id,
      packageHash: data(v).packageHash,
      confirmPublishExactTest: true as const,
    });
    const enable = () => {
      vi.stubEnv("EXECUTION_MODE", "live");
      vi.stubEnv("ENABLE_EXTERNAL_WRITES", "true");
    };
    const remote = (state = "PUBLISHED", integration = "account-one") =>
      json({
        posts: [
          {
            id: "remote-test-one",
            state,
            publishDate: new Date().toISOString(),
            integration: { id: integration },
          },
        ],
      });
    it("prepares an exact fixed package without transmission and fails closed for default gates", async () => {
      const a = await prepare(),
        b = await prepare();
      expect(a.id).toBe(b.id);
      expect(data(a).body).toMatch(/^EDS Orbit connection verification/);
      expect(data(a).type).toBe("now");
      const fetch = vi.fn();
      vi.stubEnv("EXECUTION_MODE", "test");
      vi.stubEnv("ENABLE_EXTERNAL_WRITES", "false");
      await expect(
        executePostizVerification(scope, approval(a), { fetch }),
      ).rejects.toThrow("POSTIZ_EXTERNAL_WRITES_DISABLED");
      expect(fetch).not.toHaveBeenCalled();
    });
    it("enables only the observed account after receipt then PUBLISHED status, never just HTTP success", async () => {
      enable();
      const v = await prepare();
      const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init!.body));
        expect(init!.method).toBe("POST");
        expect(body.type).toBe("now");
        expect(body.posts).toHaveLength(1);
        expect(body.posts[0].value[0]).toEqual({
          content: data(v).body,
          image: [],
        });
        return json([
          { postId: "remote-test-one", integration: "account-one" },
        ]);
      });
      expect(
        data(await executePostizVerification(scope, approval(v), { fetch }))
          .status,
      ).toBe("accepted");
      expect(
        data(await run((tx) => entity(tx, scope, "connectors", connectorId)))
          .status,
      ).toBe("read_verified");
      await executePostizVerification(scope, approval(v), { fetch });
      expect(fetch).toHaveBeenCalledTimes(1);
      const check = vi.fn(async () => remote());
      expect(
        data(await reconcilePostizVerification(scope, v.id, { fetch: check }))
          .status,
      ).toBe("verified");
      const c = data(
        await run((tx) => entity(tx, scope, "connectors", connectorId)),
      );
      expect(c.status).toBe("write_verified");
      expect(c.writeVerifiedIntegrationIds).toEqual(["account-one"]);
      expect(c.writeVerification).toMatchObject({
        remoteId: "remote-test-one",
        observedState: "PUBLISHED",
        capability: "text_publish_now",
        instanceId: "synthetic-postiz-instance",
      });
      await reconcilePostizVerification(scope, v.id, { fetch: check });
      expect(check).toHaveBeenCalledTimes(1);
    });
    it("does not grant verification for queued, absent or wrong-account observations", async () => {
      enable();
      const v = await prepare();
      await executePostizVerification(scope, approval(v), {
        fetch: async () =>
          json([{ postId: "remote-test-one", integration: "account-one" }]),
      });
      for (const fetch of [
        async () => remote("QUEUE"),
        async () => json({ posts: [] }),
        async () => remote("PUBLISHED", "account-other"),
      ])
        expect(
          data(await reconcilePostizVerification(scope, v.id, { fetch }))
            .status,
        ).toBe("accepted");
      expect(
        data(await run((tx) => entity(tx, scope, "connectors", connectorId)))
          .status,
      ).toBe("read_verified");
    });
    it("never automatically retries an unknown create or interrupted sending claim", async () => {
      enable();
      const v = await prepare();
      const fetch = vi.fn(async () => {
        throw new Error("network disconnected");
      });
      expect(
        data(await executePostizVerification(scope, approval(v), { fetch }))
          .status,
      ).toBe("outcome_unknown");
      await executePostizVerification(scope, approval(v), { fetch });
      expect(fetch).toHaveBeenCalledTimes(1);
      await run(async (tx) => {
        const row = await entity(tx, scope, "connector_verifications", v.id);
        return update(tx, scope, row, {
          ...data(row),
          status: "sending",
          approvedAt: new Date(Date.now() - 61000).toISOString(),
        });
      });
      expect(
        data(await reconcilePostizVerification(scope, v.id, { fetch })).status,
      ).toBe("outcome_unknown");
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    it("rejects stale package, expired approval, changed connector and pause before handoff", async () => {
      enable();
      const v = await prepare(),
        fetch = vi.fn();
      await expect(
        executePostizVerification(
          scope,
          { ...approval(v), packageHash: "f".repeat(64) },
          { fetch },
        ),
      ).rejects.toThrow("POSTIZ_TEST_PACKAGE_CHANGED");
      await authDb.project.update({
        where: { id: scope.projectId },
        data: { paused: true },
      });
      await expect(
        executePostizVerification(scope, approval(v), { fetch }),
      ).rejects.toThrow("PROJECT_PAUSED");
      await authDb.project.update({
        where: { id: scope.projectId },
        data: { paused: false },
      });
      await run(async (tx) => {
        const c = await entity(tx, scope, "connectors", connectorId);
        return update(tx, scope, c, {
          ...data(c),
          baseUrl: "https://changed.example.invalid/public/v1",
        });
      });
      await expect(
        executePostizVerification(scope, approval(v), { fetch }),
      ).rejects.toThrow("POSTIZ_VERIFICATION_DEPENDENCY_CHANGED");
      await run(async (tx) => {
        const r = await entity(tx, scope, "connector_verifications", v.id);
        return update(tx, scope, r, {
          ...data(r),
          expiresAt: new Date(Date.now() - 1).toISOString(),
        });
      });
      await expect(
        executePostizVerification(scope, approval(v), { fetch }),
      ).rejects.toThrow("POSTIZ_TEST_APPROVAL_EXPIRED");
      expect(fetch).not.toHaveBeenCalled();
    });
    async function mediaVerification() {
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6iAAAAABJRU5ErkJggg==",
        "base64",
      );
      const asset = await run((tx) =>
        create(tx, scope, "assets", {
          mime: "image/png",
          usageApproved: true,
          width: 1,
          height: 1,
          base64: png.toString("base64"),
        }),
      );
      const verification = await run((tx) =>
        preparePostizVerification(tx, scope, {
          connectorId,
          integrationId: "account-one",
          confirmSandboxAccount: true,
          assetId: asset.id,
        }),
      );
      return { asset, verification, png };
    }
    it("binds approved PNG bytes, persists upload receipt and verifies media only after publication", async () => {
      enable();
      const { verification, png } = await mediaVerification();
      const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url).endsWith("/upload")) {
          const file = (init!.body as FormData).get("file") as File;
          expect(Buffer.from(await file.arrayBuffer())).toEqual(png);
          return json({
            id: "media-one",
            path: "https://cdn.example.invalid/test.png",
          });
        }
        expect(JSON.parse(String(init!.body)).posts[0].value[0].image).toEqual([
          { id: "media-one", path: "https://cdn.example.invalid/test.png" },
        ]);
        return json([
          { postId: "remote-test-one", integration: "account-one" },
        ]);
      });
      const accepted = data(
        await executePostizVerification(scope, approval(verification), {
          fetch,
        }),
      );
      expect(accepted.status).toBe("accepted");
      expect(accepted.uploadedMedia.id).toBe("media-one");
      expect(fetch).toHaveBeenCalledTimes(2);
      await reconcilePostizVerification(scope, verification.id, {
        fetch: async () => remote(),
      });
      const c = data(
        await run((tx) => entity(tx, scope, "connectors", connectorId)),
      );
      expect(c.writeVerifiedMediaIntegrationIds).toEqual(["account-one"]);
      expect(c.writeVerifiedInstanceId).toBe("synthetic-postiz-instance");
      expect(c.writeVerification.capability).toBe("png_publish_now");
    });
    it("prevents post handoff when the approved PNG changes during upload", async () => {
      enable();
      const { asset, verification } = await mediaVerification();
      const fetch = vi.fn(async () => {
        await run(async (tx) => {
          const current = await entity(tx, scope, "assets", asset.id);
          await update(tx, scope, current, {
            ...data(current),
            usageApproved: false,
          });
        });
        return json({
          id: "media-one",
          path: "https://cdn.example.invalid/test.png",
        });
      });
      const result = data(
        await executePostizVerification(scope, approval(verification), {
          fetch,
        }),
      );
      expect(result.status).toBe("outcome_unknown");
      expect(result.uploadedMedia.id).toBe("media-one");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(
        data(await run((tx) => entity(tx, scope, "connectors", connectorId)))
          .status,
      ).toBe("read_verified");
    });
    it("rechecks current owner membership and project scope", async () => {
      await expect(
        run((tx) =>
          preparePostizVerification(
            tx,
            { ...scope, role: "viewer" },
            {
              connectorId,
              integrationId: "account-one",
              confirmSandboxAccount: true,
            },
          ),
        ),
      ).rejects.toThrow("OWNER_REQUIRED");
      await authDb.workspaceMember.updateMany({
        where: { workspaceId, userId },
        data: { role: "viewer" },
      });
      try {
        await expect(prepare()).rejects.toThrow("OWNER_REQUIRED");
      } finally {
        await authDb.workspaceMember.updateMany({
          where: { workspaceId, userId },
          data: { role: "owner" },
        });
      }
    });
  },
);
