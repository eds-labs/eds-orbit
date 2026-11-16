import { buildServer } from "../apps/api/src/server.ts";
import { writeFileSync } from "node:fs";
if (process.env.ORBIT_CONFIG_FILE)
  process.loadEnvFile(process.env.ORBIT_CONFIG_FILE);
const app = await buildServer();
const spec = app.swagger() as {
  info: Record<string, unknown>;
  paths: Record<string, unknown>;
  components?: Record<string, unknown>;
};
writeFileSync("packages/schemas/openapi.json", JSON.stringify(spec, null, 2));
// The versioned machine API (ADR 0029, CH1.2) as its own document: only
// /api/v1 paths, authenticated by a project API key.
writeFileSync(
  "packages/schemas/openapi-v1.json",
  JSON.stringify(
    {
      ...spec,
      info: { title: "EDS Orbit API v1", version: "1.0.0" },
      paths: Object.fromEntries(Object.entries(spec.paths).filter(([path]) => path.startsWith("/api/v1/"))),
      components: {
        ...spec.components,
        securitySchemes: { apiKey: { type: "http", scheme: "bearer", description: "Project API key (ok_…)" } },
      },
      security: [{ apiKey: [] }],
    },
    null,
    2,
  ),
);
await app.close();
