import { buildServer } from "../apps/api/src/server.ts";
import { writeFileSync } from "node:fs";
if (process.env.ORBIT_CONFIG_FILE)
  process.loadEnvFile(process.env.ORBIT_CONFIG_FILE);
const app = await buildServer();
writeFileSync(
  "packages/schemas/openapi.json",
  JSON.stringify(app.swagger(), null, 2),
);
await app.close();
