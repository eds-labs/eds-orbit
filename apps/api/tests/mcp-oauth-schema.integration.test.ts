import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { getAuthTables } from "better-auth/db";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";
import {
  mcpAuthDeps,
  mcpAuthPlugins,
} from "../src/platform/mcp-auth/plugins.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

// Better Auth model names (as getAuthTables reports them) that the OAuth
// provider adds; the four core tables already existed before WP-M1.
const OAUTH_MODELS = [
  "jwks",
  "oauthAccessToken",
  "oauthClient",
  "oauthClientAssertion",
  "oauthClientResource",
  "oauthConsent",
  "oauthRefreshToken",
  "oauthResource",
];
const ORBIT_MODELS = ["McpGrant", "McpGrantEvent"];

/** Prisma scalar types that can hold each Better Auth field type. */
const PRISMA_TYPES: Record<string, string[]> = {
  string: ["String"],
  "string[]": ["String"],
  number: ["Int", "BigInt", "Float"],
  boolean: ["Boolean"],
  date: ["DateTime"],
  json: ["Json"],
};

type PrismaField = {
  type: string;
  isList: boolean;
  isRequired: boolean;
  isUnique: boolean;
  isId: boolean;
};
type PrismaModel = { name: string; fields: Map<string, PrismaField> };

/**
 * Models of schema.prisma by their table name (`@@map`, else the model name).
 * The generated client's runtime DMMF drops nullability and list flags, and
 * the schema syntax this repo uses is small, so the file is read directly.
 */
function prismaModels() {
  const text = readFileSync(
    new URL("../../../packages/db/prisma/schema.prisma", import.meta.url),
    "utf8",
  );
  const models = new Map<string, PrismaModel>();
  for (const match of text.matchAll(/^model (\w+) \{\n([\s\S]*?)^\}/gm)) {
    const fields = new Map<string, PrismaField>();
    let table = match[1]!;
    for (const raw of match[2]!.split("\n")) {
      const line = raw.trim();
      const map = /^@@map\("(\w+)"\)/.exec(line);
      if (map) table = map[1]!;
      const field = /^(\w+)\s+(\w+)(\[\]|\?)?(.*)$/.exec(line);
      if (!field || line.startsWith("@@") || line.startsWith("//")) continue;
      fields.set(field[1]!, {
        type: field[2]!,
        isList: field[3] === "[]",
        isRequired: field[3] !== "?" && field[3] !== "[]",
        isUnique: /@unique\b/.test(field[4]!),
        isId: /@id\b/.test(field[4]!),
      });
    }
    models.set(table, { name: match[1]!, fields });
  }
  return models;
}

function flagOnTables() {
  const plugins = [...mcpAuthPlugins(loadConfig(), mcpAuthDeps())];
  return getAuthTables({
    plugins,
    emailAndPassword: { enabled: true },
  } as never);
}

describe("OAuth provider schema (drift guard)", () => {
  it("Prisma models cover every Better Auth table and field", () => {
    const tables = flagOnTables();
    // Prisma models by their table name, which is what Better Auth calls them.
    const byTable = prismaModels();
    expect(Object.keys(tables).sort()).toEqual(
      ["user", "session", "account", "verification", ...OAUTH_MODELS].sort(),
    );
    const problems: string[] = [];
    for (const [key, table] of Object.entries(tables)) {
      const modelName = table.modelName ?? key;
      const model = byTable.get(modelName);
      if (!model) {
        problems.push(`${modelName}: no Prisma model`);
        continue;
      }
      // Better Auth adds the `id` column itself; it is a string in every table.
      const fields = model.fields;
      const id = fields.get("id");
      if (!id || id.type !== "String" || id.isList)
        problems.push(`${modelName}.id: expected a String id`);
      for (const [fieldKey, field] of Object.entries(table.fields) as [
        string,
        {
          type: string | string[];
          required?: boolean;
          fieldName?: string;
          unique?: boolean;
        },
      ][]) {
        const name = field.fieldName ?? fieldKey;
        const prisma = fields.get(name);
        if (!prisma) {
          problems.push(`${modelName}.${name}: missing`);
          continue;
        }
        const type = String(field.type);
        if (!PRISMA_TYPES[type]?.includes(prisma.type))
          problems.push(
            `${modelName}.${name}: Better Auth ${type}, Prisma ${prisma.type}`,
          );
        if (type.endsWith("[]") !== prisma.isList)
          problems.push(`${modelName}.${name}: list mismatch`);
        // Prisma lists are never null; every other field follows `required`.
        if (!prisma.isList && field.required !== false && !prisma.isRequired)
          problems.push(`${modelName}.${name}: must be required`);
        if (!prisma.isList && field.required === false && prisma.isRequired)
          problems.push(`${modelName}.${name}: must be optional`);
        if (field.unique && !prisma.isUnique && !prisma.isId)
          problems.push(`${modelName}.${name}: must be unique`);
      }
    }
    expect(problems).toEqual([]);
    // Orbit's own tables sit beside them in the same schema.
    for (const name of ORBIT_MODELS)
      expect(byTable.has(name), `${name} exists`).toBe(true);
    // The Prisma delegate Better Auth calls is the model name, first letter lower-case.
    expect(
      [...byTable.values()].filter((m) =>
        OAUTH_MODELS.includes(m.name[0]!.toLowerCase() + m.name.slice(1)),
      ).length,
    ).toBe(OAUTH_MODELS.length);
  });
});

describe.skipIf(!enabled)("OAuth provider tables (database)", () => {
  const authUrl = process.env.TEST_AUTH_DATABASE_URL!;
  const appUrl = process.env.TEST_DATABASE_URL!;
  const tableNames = [...OAUTH_MODELS, ...ORBIT_MODELS];
  const userId = randomUUID();
  const workspaceId = randomUUID();

  beforeAll(async () => {
    await authDb.user.create({
      data: {
        id: userId,
        name: "Schema Test",
        email: `schema-${userId}@example.test`,
      },
    });
    await authDb.workspace.create({
      data: { id: workspaceId, name: "Schema test workspace" },
    });
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: workspaceId } });
    await authDb.user.deleteMany({ where: { id: userId } });
    await closeDatabase();
  });

  it("orbit_auth can CRUD the new tables, orbit_app cannot select them", async () => {
    const auth = new Client({ connectionString: authUrl });
    const app = new Client({ connectionString: appUrl });
    await auth.connect();
    await app.connect();
    try {
      const privileges = (client: Client, role: string) =>
        client.query<{ t: string; op: string; ok: boolean }>(
          `SELECT t, op, has_table_privilege($1, format('%I', t), op) AS ok
           FROM unnest($2::text[]) t CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) op`,
          [role, tableNames],
        );
      const authRows = (await privileges(auth, "orbit_auth")).rows;
      const appRows = (await privileges(app, "orbit_app")).rows;
      expect(authRows.length).toBe(tableNames.length * 4);
      expect(authRows.filter((r) => !r.ok)).toEqual([]);
      expect(appRows.filter((r) => r.ok)).toEqual([]);
      // The role really is refused, not only reported as such.
      await expect(
        app.query('SELECT 1 FROM "oauthClient" LIMIT 1'),
      ).rejects.toThrow(/permission denied/);
      await expect(
        app.query('SELECT 1 FROM "McpGrant" LIMIT 1'),
      ).rejects.toThrow(/permission denied/);

      // CRUD as orbit_auth through the model delegates Better Auth uses.
      const clientId = `https://client-${randomUUID()}.test/client.json`;
      await authDb.oauthClient.create({
        data: {
          id: randomUUID(),
          clientId,
          redirectUris: ["https://client.test/callback"],
          scopes: ["openid"],
          disabled: false,
          metadata: { source: "test" },
        },
      });
      const found = await authDb.oauthClient.findUniqueOrThrow({
        where: { clientId },
      });
      expect(found.redirectUris).toEqual(["https://client.test/callback"]);
      await authDb.oauthClient.update({
        where: { clientId },
        data: { disabled: true },
      });
      await authDb.oauthConsent.create({
        data: {
          id: randomUUID(),
          clientId,
          userId,
          referenceId: workspaceId,
          scopes: ["openid"],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      // Removing the client takes its consent with it.
      await authDb.oauthClient.delete({ where: { clientId } });
      expect(await authDb.oauthConsent.count({ where: { clientId } })).toBe(0);

      const grant = await authDb.mcpGrant.create({
        data: {
          userId,
          clientId,
          workspaceId,
          scopes: ["orbit:read"],
          status: "pending",
        },
      });
      expect(grant.projectIds).toEqual([]);
      expect(grant.allCurrentProjects).toBe(false);
      await authDb.mcpGrantEvent.create({
        data: { grantId: grant.id, userId, clientId, workspaceId, action: "x" },
      });
      await authDb.mcpGrantEvent.deleteMany({ where: { grantId: grant.id } });
      await authDb.mcpGrant.delete({ where: { id: grant.id } });
    } finally {
      await auth.end();
      await app.end();
    }
  });

  it("only one active grant per user, client and workspace", async () => {
    const clientId = `https://client-${randomUUID()}.test/client.json`;
    const base = { userId, clientId, workspaceId, scopes: ["orbit:read"] };
    const first = await authDb.mcpGrant.create({
      data: { ...base, status: "active" },
    });
    await expect(
      authDb.mcpGrant.create({ data: { ...base, status: "active" } }),
    ).rejects.toMatchObject({ code: "P2002" });
    // Other states are not limited: history keeps revoked and pending rows.
    await authDb.mcpGrant.create({ data: { ...base, status: "revoked" } });
    await authDb.mcpGrant.create({ data: { ...base, status: "revoked" } });
    await authDb.mcpGrant.create({ data: { ...base, status: "pending" } });
    // Another workspace or client is independent.
    const other = randomUUID();
    await authDb.workspace.create({ data: { id: other, name: "Other" } });
    await authDb.mcpGrant.create({
      data: { ...base, workspaceId: other, status: "active" },
    });
    // Revoking frees the slot.
    await authDb.mcpGrant.update({
      where: { id: first.id },
      data: { status: "revoked", revokedAt: new Date(), revokedBy: userId },
    });
    await authDb.mcpGrant.create({ data: { ...base, status: "active" } });
    // Deleting the workspace removes its grants.
    await authDb.workspace.delete({ where: { id: other } });
    expect(await authDb.mcpGrant.count({ where: { workspaceId: other } })).toBe(
      0,
    );
    await authDb.mcpGrant.deleteMany({ where: { clientId } });
  });

  it("status is limited to pending, active and revoked; sessionId is indexed (WP-M5)", async () => {
    const clientId = `https://client-${randomUUID()}.test/client.json`;
    const base = { userId, clientId, workspaceId, scopes: ["orbit:read"] };
    for (const status of ["pending", "active", "revoked"])
      await authDb.mcpGrant.create({ data: { ...base, status } });
    for (const status of ["", "Active", "denied", "expired"])
      await expect(
        authDb.mcpGrant.create({ data: { ...base, status } }),
        status,
      ).rejects.toThrow(/McpGrant_status_check/);
    // The selection remembers which authorization request it was made for.
    const bound = await authDb.mcpGrant.create({
      data: {
        ...base,
        status: "pending",
        sessionId: randomUUID(),
        requestHash: "a".repeat(43),
      },
    });
    expect(bound.requestHash).toBe("a".repeat(43));
    const indexes = await authDb.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'McpGrant' AND indexname = 'McpGrant_sessionId_idx'`;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]!.indexdef).toContain('("sessionId")');
    await authDb.mcpGrant.deleteMany({ where: { clientId } });
  });
});
