import { existsSync } from "node:fs";
if (existsSync(".runtime/local.env")) process.loadEnvFile(".runtime/local.env");
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.AUTH_DATABASE_URL = process.env.TEST_AUTH_DATABASE_URL;
  process.env.MIGRATION_DATABASE_URL = process.env.TEST_MIGRATION_DATABASE_URL;
}
