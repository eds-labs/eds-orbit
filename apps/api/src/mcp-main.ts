// Entrypoint of the MCP gateway process (Track M, WP-M2/WP-M5): `tsx
// apps/api/src/mcp-main.ts`. With ORBIT_MCP_GATEWAY and ORBIT_MCP_OAUTH both
// "true" it serves the gateway; otherwise it stays up as a health-only app
// (`/healthz` → disabled, everything else 404) that loads no auth, database
// or SDK code, so the compose service never crash-loops (platform/mcp/
// bootstrap.ts). The API and web never load this file.
import { loadConfig } from "../../../packages/config/src/index.ts";
import { createMcpGatewayProcess } from "./platform/mcp/bootstrap.ts";
import { makeShutdown } from "./platform/mcp/shutdown.ts";

const config = loadConfig();
const { app, closers, mode } = await createMcpGatewayProcess(config);
await app.listen({
  port: config.MCP_PORT,
  host: process.env.BIND_HOST ?? "127.0.0.1",
});
console.log(
  mode === "enabled"
    ? "Orbit MCP gateway listening on configured interface"
    : "Orbit MCP gateway disabled (health check only), listening on configured interface",
);
// One shutdown however many signals arrive; a failing close is logged by
// error name and the process still exits.
const shutdown = makeShutdown({
  steps: [() => app.close(), ...closers],
  exit: (code) => process.exit(code),
  log: (...args) => console.error(...args),
});
for (const event of ["SIGINT", "SIGTERM"])
  process.on(event, () => void shutdown());
