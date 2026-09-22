import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
if (existsSync(".runtime/local.env")) process.loadEnvFile(".runtime/local.env");
const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
};
const sourceUrls = {
  migration: new URL(required("TEST_MIGRATION_DATABASE_URL")),
  app: new URL(required("TEST_DATABASE_URL")),
  auth: new URL(required("TEST_AUTH_DATABASE_URL")),
};
for (const url of Object.values(sourceUrls)) {
  if (
    url.hostname !== "127.0.0.1" ||
    url.port !== "55432" ||
    url.pathname !== "/orbit_test"
  )
    throw new Error("Isolated Orbit test database configuration required");
}
if (
  sourceUrls.migration.username !== "orbit_migrator" ||
  sourceUrls.app.username !== "orbit_app" ||
  sourceUrls.auth.username !== "orbit_auth"
)
  throw new Error("Expected isolated Orbit database roles");

const database = `orbit_cp07_${process.pid}_${Date.now()}`;
if (!/^orbit_cp07_\d+_\d+$/.test(database))
  throw new Error("Invalid disposable database identifier");
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const withDatabase = (url: URL) => {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next.toString();
};
const disposable = {
  MIGRATION_DATABASE_URL: withDatabase(sourceUrls.migration),
  DATABASE_URL: withDatabase(sourceUrls.app),
  AUTH_DATABASE_URL: withDatabase(sourceUrls.auth),
};
const adminUrl = new URL(sourceUrls.migration);
adminUrl.pathname = "/postgres";
const admin = new Client({ connectionString: adminUrl.toString() });
let adminConnected = false;
const run = (args: string[], env: NodeJS.ProcessEnv) => {
  const result = spawnSync(process.execPath, args, {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env,
    encoding: "utf8",
    maxBuffer: 4_000_000,
    timeout: 120_000,
  });
  if (result.status !== 0)
    throw new Error(
      "Disposable migration command failed; inspect local diagnostics",
    );
};

try {
  await admin.connect();
  adminConnected = true;
  await admin.query(
    `CREATE DATABASE ${quoteIdentifier(database)} OWNER orbit_migrator`,
  );
  const migrator = new Client({
    connectionString: disposable.MIGRATION_DATABASE_URL,
  });
  let migratorConnected = false;
  try {
    await migrator.connect();
    migratorConnected = true;
    for (const migration of [
      "202609170001_foundation",
      "202609170002_index_generations",
    ]) {
      const sql = readFileSync(
        fileURLToPath(
          new URL(
            `../packages/db/prisma/migrations/${migration}/migration.sql`,
            import.meta.url,
          ),
        ),
        "utf8",
      );
      await migrator.query(sql);
      run(
        [
          require.resolve("prisma/build/index.js"),
          "migrate",
          "resolve",
          "--applied",
          migration,
          "--config",
          fileURLToPath(
            new URL("../packages/db/prisma.config.ts", import.meta.url),
          ),
        ],
        { ...process.env, ...disposable },
      );
    }
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const entityId = randomUUID();
    await migrator.query(
      `INSERT INTO "Workspace" (id,name) VALUES ($1,'Legacy workspace')`,
      [workspaceId],
    );
    await migrator.query(
      `INSERT INTO "Project" (id,"workspaceId",name) VALUES ($1,$2,'Legacy project')`,
      [projectId, workspaceId],
    );
    await migrator.query(
      `INSERT INTO "Entity" (id,"workspaceId","projectId",kind,data,"updatedAt") VALUES ($1,$2,$3,'facts',$4,now())`,
      [entityId, workspaceId, projectId, { key: "legacy.fact", value: "kept" }],
    );
    await migrator.end();
    migratorConnected = false;

    run(["--import", "tsx", "scripts/db-deploy.ts"], {
      ...process.env,
      ...disposable,
    });

    const verify = new Client({
      connectionString: disposable.MIGRATION_DATABASE_URL,
    });
    try {
      await verify.connect();
      const preserved = await verify.query(
        `SELECT data FROM "Entity" WHERE id=$1`,
        [entityId],
      );
      if (preserved.rows[0]?.data?.value !== "kept")
        throw new Error("Legacy entity was not preserved");
      const profileTables = await verify.query(
        `SELECT relname, relforcerowsecurity FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY relname`,
        [["ProjectMarketingProfile", "ProjectMarketingProfileVersion"]],
      );
      if (
        profileTables.rowCount !== 2 ||
        profileTables.rows.some((row) => row.relforcerowsecurity !== true)
      )
        throw new Error("Marketing profile tables or forced RLS missing");
      const applied = await verify.query(
        `SELECT 1 FROM "_prisma_migrations" WHERE migration_name=$1 AND finished_at IS NOT NULL`,
        ["202609180003_project_marketing_profile"],
      );
      if (applied.rowCount !== 1)
        throw new Error("Marketing profile migration was not recorded");
    } finally {
      await verify.end();
    }
  } finally {
    if (migratorConnected) await migrator.end();
  }
  console.log(
    "CP07 passed: forward migration preserved legacy data and enforced profile RLS in a disposable local database.",
  );
} finally {
  if (adminConnected) {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`);
    await admin.end();
    adminConnected = false;
  }
}
