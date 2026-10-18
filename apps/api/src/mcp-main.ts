// Entrypoint of the MCP gateway process (Track M, WP-M2): `tsx
// apps/api/src/mcp-main.ts`. It refuses to start unless ORBIT_MCP_GATEWAY
// and ORBIT_MCP_OAUTH are both "true" (exit code 1); the API and web never
// load it. Only the config and the guard are imported before the check.
import { loadConfig } from "../../../packages/config/src/index.ts";
import { assertMcpGatewayEnabled } from "./platform/mcp/gateway-guard.ts";

const config = loadConfig();
try {
  assertMcpGatewayEnabled(config);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const { registerModules } = await import("./modules/registry.ts");
const { buildMcpServer } = await import("./platform/mcp/server.ts");
const { closeDatabase } = await import("../../../packages/db/src/index.ts");
const { makeShutdown } = await import("./platform/mcp/shutdown.ts");

// A broken module manifest stops the gateway before it serves anything.
registerModules();
const app = await buildMcpServer();
await app.listen({
  port: config.MCP_PORT,
  host: process.env.BIND_HOST ?? "127.0.0.1",
});
console.log("Orbit MCP gateway listening on configured interface");
// One shutdown however many signals arrive; a failing close is logged by
// error name and the process still exits.
const shutdown = makeShutdown({
  steps: [() => app.close(), () => closeDatabase()],
  exit: (code) => process.exit(code),
  log: (...args) => console.error(...args),
});
for (const event of ["SIGINT", "SIGTERM"])
  process.on(event, () => void shutdown());
