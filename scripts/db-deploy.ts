/** Explicit migration/grant command. Never imported by an application process. */
import { Client } from "pg";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const args = new Set(process.argv.slice(2));
const env = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
};
const urls = {
  migration: new URL(env("MIGRATION_DATABASE_URL")),
  app: new URL(env("DATABASE_URL")),
  auth: new URL(env("AUTH_DATABASE_URL")),
};
function sameDatabase(a: URL, b: URL) {
  return (
    a.protocol === b.protocol &&
    a.hostname === b.hostname &&
    a.port === b.port &&
    a.pathname === b.pathname
  );
}
if (
  !sameDatabase(urls.migration, urls.app) ||
  !sameDatabase(urls.migration, urls.auth)
)
  throw new Error("All role URLs must point to the same database");
if (!["postgres:", "postgresql:"].includes(urls.migration.protocol))
  throw new Error("PostgreSQL URL required");
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(urls.migration.hostname) &&
  (!args.has("--allow-remote-migration") || !process.env.ORBIT_RELEASE_APPROVAL)
)
  throw new Error(
    "Remote database requires --allow-remote-migration and ORBIT_RELEASE_APPROVAL change reference",
  );
const roles = [
  {
    name: decodeURIComponent(urls.app.username),
    password: decodeURIComponent(urls.app.password),
  },
  {
    name: decodeURIComponent(urls.auth.username),
    password: decodeURIComponent(urls.auth.password),
  },
];
if (roles[0]!.name !== "orbit_app" || roles[1]!.name !== "orbit_auth")
  throw new Error(
    "This schema requires the separate orbit_app and orbit_auth roles",
  );
if (
  roles.some((role) => role.password.length < 24) ||
  urls.migration.username === urls.app.username ||
  urls.migration.username === urls.auth.username
)
  throw new Error(
    "Distinct migrator and strong dedicated role credentials are required",
  );
const identifier = (value: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
    throw new Error("Invalid SQL identifier");
  return '"' + value + '"';
};
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const migrator = new Client({ connectionString: urls.migration.toString() });
try {
  await migrator.connect();
  await migrator.query("SET standard_conforming_strings = on");
  for (const role of roles) {
    const found = await migrator.query(
      "SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=$1",
      [role.name],
    );
    if (!found.rowCount)
      await migrator.query(
        `CREATE ROLE ${identifier(role.name)} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD ${literal(role.password)}`,
      );
    else {
      const r = found.rows[0];
      if (
        !r.rolcanlogin ||
        r.rolsuper ||
        r.rolbypassrls ||
        r.rolcreatedb ||
        r.rolcreaterole ||
        r.rolreplication
      )
        throw new Error(
          "Existing application role has unsafe attributes; manual role repair required",
        );
    }
    const memberships = await migrator.query(
      "SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=$1",
      [role.name],
    );
    if (memberships.rowCount)
      throw new Error(
        "Application roles must not inherit or assume other roles",
      );
  }
  if (!args.has("--grants-only")) {
    const prismaEntry = require.resolve("prisma/build/index.js");
    const config = fileURLToPath(
      new URL("../packages/db/prisma.config.ts", import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      [prismaEntry, "migrate", "deploy", "--config", config],
      {
        env: process.env,
        encoding: "utf8",
        maxBuffer: 4_000_000,
        timeout: 120000,
      },
    );
    // CLI output can contain datasource descriptions; never relay credentials or raw SQL errors.
    if (result.status !== 0)
      throw new Error(
        "Migration failed; inspect sanitized local migration diagnostics",
      );
  }
  await migrator.query("BEGIN");
  await migrator.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
  await migrator.query(
    "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM orbit_app, orbit_auth",
  );
  await migrator.query("GRANT USAGE ON SCHEMA public TO orbit_app, orbit_auth");
  const authTables = [
    "user",
    "session",
    "account",
    "verification",
    "Workspace",
    "WorkspaceMember",
    "Project",
    "ProjectMember",
  ];
  await migrator.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ${authTables.map(identifier).join(",")} TO orbit_auth`,
  );
  const business = [
    "Entity",
    "EntityVersion",
    "Outbox",
    "BudgetReservation",
    "KnowledgeDocument",
    "DocumentVersion",
    "KnowledgeChunk",
    "ChunkEmbedding",
    "KnowledgeIndex",
    "ProjectMarketingProfile",
    "ProjectMarketingProfileVersion",
  ];
  await migrator.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON ${business.map(identifier).join(",")} TO orbit_app`,
  );
  await migrator.query('GRANT SELECT,UPDATE ON "Project" TO orbit_app');
  await migrator.query('GRANT SELECT,INSERT ON "AuditEvent" TO orbit_app');
  const owned = await migrator.query(
    "SELECT 1 FROM pg_tables WHERE schemaname='public' AND tableowner=ANY($1::text[])",
    [roles.map((r) => r.name)],
  );
  if (owned.rowCount)
    throw new Error("Application/auth roles must not own tables");
  await migrator.query("COMMIT");
  const app = new Client({ connectionString: urls.app.toString() }),
    auth = new Client({ connectionString: urls.auth.toString() });
  try {
    await app.connect();
    await auth.connect();
    const matrix = await app.query(
      "SELECT current_user,has_table_privilege(current_user,'\"Entity\"','SELECT') AS business,has_table_privilege(current_user,'\"AuditEvent\"','UPDATE') AS audit_update,has_table_privilege(current_user,'\"user\"','SELECT') AS auth_read",
    );
    const r = matrix.rows[0];
    if (
      r.current_user !== "orbit_app" ||
      !r.business ||
      r.audit_update ||
      r.auth_read
    )
      throw new Error("Application role matrix verification failed");
    const authMatrix = await auth.query(
      "SELECT current_user,has_table_privilege(current_user,'\"Entity\"','SELECT') AS business,has_table_privilege(current_user,'\"user\"','SELECT') AS auth_read",
    );
    const a = authMatrix.rows[0];
    if (a.current_user !== "orbit_auth" || a.business || !a.auth_read)
      throw new Error("Authentication role matrix verification failed");
    const unscoped = await app.query(
      'SELECT count(*)::int AS count FROM "Entity"',
    );
    if (unscoped.rows[0].count !== 0)
      throw new Error("Unscoped RLS verification failed");
  } finally {
    await app.end();
    await auth.end();
  }
  console.log(
    "Migration, least-privilege grants and real-role isolation checks completed.",
  );
} catch (error) {
  try {
    await migrator.query("ROLLBACK");
  } catch {
    /* Connection may already be closed. */
  }
  console.error(
    error instanceof Error && !("code" in error)
      ? error.message
      : "Database initialization failed; raw driver details suppressed.",
  );
  process.exitCode = 1;
} finally {
  await migrator.end();
}
