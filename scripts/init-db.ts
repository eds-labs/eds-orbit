import { Client } from "pg";
if (process.env.ORBIT_LOCAL_SETUP !== "1")
  throw new Error("Local setup flag required");
const url = process.env.MIGRATION_DATABASE_URL!;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  new URL(url).port !== "55432"
)
  throw new Error("Isolated local database required");
const c = new Client({ connectionString: url });
await c.connect();
for (const [role, key] of [
  ["orbit_app", "APP_DB_PASSWORD"],
  ["orbit_auth", "AUTH_DB_PASSWORD"],
]) {
  const password = process.env[key!];
  if (!password || !/^[a-f0-9]{64}$/.test(password))
    throw new Error("Generated local password required");
  const exists = await c.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
    role,
  ]);
  if (!exists.rowCount)
    await c.query(
      `CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}'`,
    );
}
const exists = await c.query("SELECT 1 FROM pg_database WHERE datname=$1", [
  "orbit_test",
]);
if (!exists.rowCount)
  await c.query("CREATE DATABASE orbit_test OWNER orbit_migrator");
await c.end();
console.log("Isolated Orbit roles and test database initialized");
