/**
 * Gives this worktree its own local integration test database, so parallel
 * branches with different migrations stop breaking each other's tests.
 *
 *   node scripts/test-db-for-worktree.ts           create if missing, migrate, write .runtime/test.env
 *   node scripts/test-db-for-worktree.ts --reset   drop and recreate it first
 *   node scripts/test-db-for-worktree.ts --drop    drop it and remove .runtime/test.env
 *
 * Credentials come from the TEST_* URLs in the environment or from
 * `.runtime/local.env` (this worktree's, else the main checkout's). Only the
 * isolated local Postgres (127.0.0.1:55432) is accepted, and only the derived
 * `orbit_test_<slug>` database is created or dropped; the shared `orbit_test`
 * is never touched. tests/setup.ts prefers the written file.
 */
import { Client } from "pg";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  isLocalTestDatabase,
  testUrlKeys,
  worktreeTestDatabase,
  worktreeTestEnvFile,
} from "./test-database.ts";

const args = new Set(process.argv.slice(2));
for (const arg of args)
  if (!["--reset", "--drop"].includes(arg))
    throw new Error(`Unknown option ${arg}`);
const git = (...gitArgs: string[]) =>
  execFileSync("git", gitArgs, { encoding: "utf8" }).trim();
const root = git("rev-parse", "--show-toplevel");
const mainCheckout = dirname(
  git("rev-parse", "--path-format=absolute", "--git-common-dir"),
);
if (!process.env.TEST_MIGRATION_DATABASE_URL)
  for (const dir of [root, mainCheckout]) {
    const file = join(dir, ".runtime/local.env");
    if (existsSync(file)) {
      process.loadEnvFile(file);
      break;
    }
  }
const base = Object.fromEntries(
  testUrlKeys.map((key) => {
    const value = process.env[key];
    if (!value)
      throw new Error(`${key} is required (run pnpm local:setup first)`);
    return [key, new URL(value)];
  }),
) as Record<(typeof testUrlKeys)[number], URL>;
for (const url of Object.values(base))
  if (!isLocalTestDatabase(url))
    throw new Error(
      "Worktree test databases are restricted to the local Orbit Postgres at 127.0.0.1:55432",
    );
if (
  base.TEST_MIGRATION_DATABASE_URL.username !== "orbit_migrator" ||
  base.TEST_DATABASE_URL.username !== "orbit_app" ||
  base.TEST_AUTH_DATABASE_URL.username !== "orbit_auth"
)
  throw new Error("Expected the isolated Orbit database roles");

const database = worktreeTestDatabase(root);
if (database === "orbit_test" || !/^orbit_test_[a-z0-9_]+$/.test(database))
  throw new Error("Invalid worktree test database name");
const withDatabase = (url: URL, name: string) => {
  const next = new URL(url);
  next.pathname = "/" + name;
  return next;
};
const urls = Object.fromEntries(
  testUrlKeys.map((key) => [key, withDatabase(base[key], database)]),
) as Record<(typeof testUrlKeys)[number], URL>;
const envFile = join(root, worktreeTestEnvFile);
// The name matches /^orbit_test_[a-z0-9_]+$/, so quoting needs no escaping.
const quoted = `"${database}"`;

const admin = new Client({
  connectionString: withDatabase(
    base.TEST_MIGRATION_DATABASE_URL,
    "postgres",
  ).toString(),
});
await admin.connect();
try {
  const exists = async () =>
    Boolean(
      (
        await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [
          database,
        ])
      ).rowCount,
    );
  if (args.has("--drop") || args.has("--reset")) {
    // Fails while a test run still holds connections; nothing is forced.
    await admin.query(`DROP DATABASE IF EXISTS ${quoted}`);
    rmSync(envFile, { force: true });
    console.log(`Dropped local test database ${database}.`);
    if (args.has("--drop")) process.exit(0);
  }
  if (!(await exists())) {
    await admin.query(
      `CREATE DATABASE ${quoted} OWNER orbit_migrator TEMPLATE template0`,
    );
    console.log(`Created local test database ${database}.`);
  }
  // A database migrated by another branch (the worktree switched branches)
  // holds migrations this branch lacks; Prisma would apply around them.
  const migrator = new Client({
    connectionString: urls.TEST_MIGRATION_DATABASE_URL.toString(),
  });
  await migrator.connect();
  try {
    const table = await migrator.query(
      "SELECT to_regclass('public._prisma_migrations') AS name",
    );
    if (table.rows[0].name) {
      const local = new Set(
        readdirSync(join(root, "packages/db/prisma/migrations"), {
          withFileTypes: true,
        })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name),
      );
      const applied = await migrator.query(
        "SELECT migration_name FROM _prisma_migrations WHERE rolled_back_at IS NULL",
      );
      const foreign = applied.rows
        .map((row) => row.migration_name as string)
        .filter((name) => !local.has(name));
      if (foreign.length)
        throw new Error(
          `${database} holds migrations this branch does not have (${foreign.join(", ")}); rerun with --reset`,
        );
    }
  } finally {
    await migrator.end();
  }
  const deploy = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/db-deploy.ts"],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: urls.TEST_MIGRATION_DATABASE_URL.toString(),
        DATABASE_URL: urls.TEST_DATABASE_URL.toString(),
        AUTH_DATABASE_URL: urls.TEST_AUTH_DATABASE_URL.toString(),
      },
    },
  );
  if (deploy.status !== 0) throw new Error(`db-deploy failed for ${database}`);
  await admin.query(
    `GRANT CONNECT ON DATABASE ${quoted} TO orbit_app, orbit_auth`,
  );
  mkdirSync(dirname(envFile), { recursive: true });
  writeFileSync(
    envFile,
    "# Written by scripts/test-db-for-worktree.ts; tests/setup.ts prefers it.\n" +
      testUrlKeys.map((key) => `${key}=${urls[key]}`).join("\n") +
      "\n",
    { mode: 0o600 },
  );
  console.log(
    `${database} is migrated for this branch; ${worktreeTestEnvFile} written (credentials not printed).`,
  );
} finally {
  await admin.end();
}
