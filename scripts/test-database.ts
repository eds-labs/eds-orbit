/**
 * Local integration test databases. Every worktree may own a database
 * `orbit_test_<slug>` (scripts/test-db-for-worktree.ts) next to the shared
 * `orbit_test`, so parallel branches with different migrations never reissue
 * each other's grants. Its Redis keys (`orbit:<name>:<PUBLISHER_INSTANCE_ID>`)
 * and queues (`<QUEUE_NAMESPACE>-<class>`) get a matching name, so parallel
 * runs on the shared local Redis do not see each other's state either.
 * Shared by the test setup and the local test scripts.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseEnv } from "node:util";

/** Worktree-local file with the three TEST_* URLs; under the ignored `.runtime/`. */
export const worktreeTestEnvFile = ".runtime/test.env";
export const testUrlKeys = [
  "TEST_DATABASE_URL",
  "TEST_AUTH_DATABASE_URL",
  "TEST_MIGRATION_DATABASE_URL",
] as const;
const testDatabaseName = /^orbit_test(?:_[a-z0-9]+(?:_[a-z0-9]+)*)?$/;

/** `orbit_test_<worktree name>_<path hash>`; the hash keeps equal names apart. */
export function worktreeTestDatabase(worktreePath: string) {
  const slug =
    basename(worktreePath)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32)
      .replace(/_+$/, "") || "worktree";
  const hash = createHash("sha256")
    .update(worktreePath)
    .digest("hex")
    .slice(0, 6);
  return `orbit_test_${slug}_${hash}`;
}

/** PUBLISHER_INSTANCE_ID and QUEUE_NAMESPACE of a worktree database's runs. */
export function worktreeRedisNamespace(database: string) {
  return database.replaceAll("_", "-");
}

/**
 * The isolated local Postgres (127.0.0.1:55432) and a test database name:
 * the shared `orbit_test` or a per-worktree `orbit_test_<slug>`.
 */
export function isLocalTestDatabase(url: URL) {
  return (
    url.hostname === "127.0.0.1" &&
    url.port === "55432" &&
    testDatabaseName.test(url.pathname.slice(1))
  );
}

/**
 * Loads `.runtime/test.env` over the TEST_* URLs, PUBLISHER_INSTANCE_ID and
 * QUEUE_NAMESPACE already in the environment (usually the shared ones from the
 * main checkout's `.runtime/local.env`). Returns the database name, or
 * undefined when the file does not exist.
 */
export function loadWorktreeTestEnv(file = worktreeTestEnvFile) {
  if (!existsSync(file)) return undefined;
  const entries = parseEnv(readFileSync(file, "utf8"));
  const databases = new Set<string>();
  for (const key of testUrlKeys) {
    const value = entries[key];
    if (!value || !isLocalTestDatabase(new URL(value)))
      throw new Error(
        `${file}: ${key} must name a local Orbit test database; rerun scripts/test-db-for-worktree.ts`,
      );
    databases.add(new URL(value).pathname.slice(1));
  }
  if (databases.size !== 1)
    throw new Error(`${file}: all TEST_* URLs must name the same database`);
  const database = [...databases][0]!;
  const namespace = worktreeRedisNamespace(database);
  for (const key of ["PUBLISHER_INSTANCE_ID", "QUEUE_NAMESPACE"])
    if (entries[key] !== namespace)
      throw new Error(
        `${file}: ${key} must be ${namespace}; rerun scripts/test-db-for-worktree.ts`,
      );
  for (const key of testUrlKeys) process.env[key] = entries[key];
  process.env.PUBLISHER_INSTANCE_ID = namespace;
  process.env.QUEUE_NAMESPACE = namespace;
  return database;
}
