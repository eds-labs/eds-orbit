// Entrypoint of the internal webmail bridge (ADR 0026): `tsx
// apps/api/src/webmail-bridge-main.ts`. With webmail off it stays up as a
// health-only app that loads no database or module code
// (modules/webmail/bridge-bootstrap.ts). The API and web never load this file.
import { loadConfig } from "../../../packages/config/src/index.ts";
import { createWebmailBridgeProcess } from "./modules/webmail/bridge-bootstrap.ts";
import { makeShutdown } from "./platform/mcp/shutdown.ts";

const config = loadConfig();
const { app, closers, mode } = await createWebmailBridgeProcess(config, {
  register: async () =>
    (await import("./modules/registry.ts")).registerModules(),
});
await app.listen({
  port: config.WEBMAIL_BRIDGE_PORT,
  host: process.env.BIND_HOST ?? "127.0.0.1",
});
console.log(
  mode === "enabled"
    ? "Orbit webmail bridge listening on configured interface"
    : "Orbit webmail bridge disabled (health check only), listening on configured interface",
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
