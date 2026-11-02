import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import type { ServerModule } from "../../../packages/module-contracts/src/index.ts";
import { registerModules, registerTestModules } from "../src/modules/registry.ts";
import { connectionSecret } from "../src/platform/connections/central.ts";
import { centralProviders } from "../src/platform/administration/connections.ts";
import { platformActions } from "../src/platform/http/platform-actions.ts";
import {
  createProjectConnection,
  projectConnectionsByConfig,
  revokeProjectConnection,
  withProjectSecret,
} from "../src/platform/connections/project-secrets.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

// A module that exists only here: it owns one module-managed provider and
// one ordinary project provider.
const vaultModule: ServerModule = {
  id: "vault",
  version: "1.0.0",
  displayName: { en: "Vault", de: "Tresor" },
  dependsOn: [],
  defaultEnabled: true,
  entityKinds: [],
  tables: [],
  permissions: [],
};
registerTestModules([
  {
    module: vaultModule,
    contributions: {
      connections: {
        providers: {
          "vault.account": { scopes: ["project"], managedByModule: true },
          "vault.plain": { scopes: ["project"] },
        },
      },
    },
  },
]);
registerModules();

/**
 * Module-managed project connections (ADR 0020, S2 Task 2): the business
 * role only reads connections, so the platform writes them through the
 * auth role, grants them to the project, and serializes secret updates.
 */
describe.skipIf(!enabled)("project connections managed by a module", () => {
  let a: Awaited<ReturnType<typeof createSocialProject>>;
  let b: Awaited<ReturnType<typeof createSocialProject>>;
  const input = (secret = "s") => ({
    moduleId: "vault",
    provider: "vault.account",
    label: "Synthetic account",
    config: { externalId: `ext-${Math.random()}`, metaUserId: "meta-user-1" },
    secret,
    purposes: ["social_publish"],
  });

  beforeAll(async () => {
    process.env.ORBIT_CONNECTIONS = "true";
    a = await createSocialProject();
    b = await createSocialProject({ name: "Synthetic social B" });
  });
  afterAll(async () => {
    await a?.cleanup();
    await b?.cleanup();
    await closeDatabase();
  });

  it("creates a project connection that the project can read and no other project can", async () => {
    const { connectionId } = await createProjectConnection(a.owner, input("token-1"));
    expect(await a.run((tx) => connectionSecret(tx, connectionId))).toBe("token-1");
    const foreign = await b.run((tx) => tx.connection.findUnique({ where: { id: connectionId } }));
    expect(foreign).toBeNull();
    expect(await b.run((tx) => connectionSecret(tx, connectionId))).toBeNull();
  });

  it("refuses providers that are not module-managed or belong to another module", async () => {
    await expect(
      createProjectConnection(a.owner, { ...input(), provider: "vault.plain" }),
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_MANAGED" });
    await expect(
      createProjectConnection(a.owner, { ...input(), moduleId: "social" }),
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_MANAGED" });
    await expect(
      createProjectConnection(a.owner, { ...input(), provider: "postiz" }),
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_MANAGED" });
  });

  it("serializes concurrent secret updates", async () => {
    const { connectionId } = await createProjectConnection(a.owner, input("s"));
    const bump = () =>
      withProjectSecret(a.owner, { moduleId: "vault", connectionId }, async (current) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { result: current.secretVersion, secret: `${current.secret}+1` };
      });
    const seen = await Promise.all([bump(), bump()]);
    expect(seen.sort()).toEqual([1, 2]);
    expect(await a.run((tx) => connectionSecret(tx, connectionId))).toBe("s+1+1");
    const secrets = await authDb.connectionSecret.findMany({
      where: { connectionId },
      orderBy: { version: "asc" },
    });
    expect(secrets.map((s) => [s.version, s.state])).toEqual([
      [1, "retired"],
      [2, "retired"],
      [3, "active"],
    ]);
  });

  it("keeps the secret when the work returns none, and merges a returned config", async () => {
    const { connectionId } = await createProjectConnection(a.owner, input("keep"));
    const result = await withProjectSecret(a.owner, { moduleId: "vault", connectionId }, async (current) => ({
      result: current.config.metaUserId,
      config: { checkedAt: "2026-11-02T10:00:00.000Z" },
    }));
    expect(result).toBe("meta-user-1");
    const row = await authDb.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(row.config).toMatchObject({ metaUserId: "meta-user-1", checkedAt: "2026-11-02T10:00:00.000Z" });
    expect(await authDb.connectionSecret.count({ where: { connectionId } })).toBe(1);
  });

  it("refuses another project's or another module's connection", async () => {
    const { connectionId } = await createProjectConnection(a.owner, input());
    const work = async () => ({ result: 1 });
    await expect(
      withProjectSecret(b.owner, { moduleId: "vault", connectionId }, work),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      withProjectSecret(a.owner, { moduleId: "social", connectionId }, work),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      revokeProjectConnection(b.owner, { moduleId: "vault", connectionId, reason: "test" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("revocation hides the connection and its secret from the project", async () => {
    const { connectionId } = await createProjectConnection(a.owner, input("gone"));
    await revokeProjectConnection(a.owner, { moduleId: "vault", connectionId, reason: "disconnect" });
    expect(await a.run((tx) => connectionSecret(tx, connectionId))).toBeNull();
    const row = await authDb.connection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(row.revokedAt).not.toBeNull();
    expect(
      await authDb.connectionSecret.count({ where: { connectionId, state: "active" } }),
    ).toBe(0);
    await expect(
      withProjectSecret(a.owner, { moduleId: "vault", connectionId }, async () => ({ result: 1 })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("finds active project connections by a config value across projects", async () => {
    const value = `meta-user-${Math.random()}`;
    const one = await createProjectConnection(a.owner, { ...input(), config: { metaUserId: value } });
    const two = await createProjectConnection(b.owner, { ...input(), config: { metaUserId: value } });
    const revoked = await createProjectConnection(b.owner, { ...input(), config: { metaUserId: value } });
    await revokeProjectConnection(b.owner, { moduleId: "vault", connectionId: revoked.connectionId, reason: "test" });
    const found = await projectConnectionsByConfig("vault.account", "metaUserId", value);
    expect(found.map((f) => f.connectionId).sort()).toEqual([one.connectionId, two.connectionId].sort());
    expect(found.find((f) => f.connectionId === one.connectionId)).toMatchObject({
      workspaceId: a.owner.workspaceId,
      projectId: a.owner.projectId,
    });
  });

  it("offers managed providers neither to the generic connector action nor to the administration", async () => {
    expect(centralProviders().map((p) => p.id)).not.toContain("vault.account");
    await expect(
      scoped(a.owner.workspaceId, a.owner.projectId, (tx) =>
        (platformActions.connector!.run as (tx: unknown, ctx: unknown) => Promise<unknown>)(tx, {
          scope: a.owner,
          input: { provider: "vault.account", credential: "0123456789abcdef" },
          config: { CREDENTIAL_KEY: "0".repeat(64) },
        } as never),
      ),
    ).rejects.toThrow(/Invalid option|invalid_value|provider/);
  });

  it("keeps secrets out of the system audit", async () => {
    const { connectionId } = await createProjectConnection(a.owner, input("audit-secret-value"));
    await withProjectSecret(a.owner, { moduleId: "vault", connectionId }, async () => ({
      result: 0,
      secret: "audit-secret-rotated",
    }));
    const rows = await authDb.systemAuditEvent.findMany({ where: { targetId: connectionId } });
    expect(rows.map((r) => r.action).sort()).toEqual(["connection.created", "connection.secret_rotated"]);
    expect(JSON.stringify(rows)).not.toMatch(/audit-secret/);
  });
});
