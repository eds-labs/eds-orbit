/**
 * Smoke test of a running Orbit MCP gateway (Track M, WP-M5, D-M5-10); the
 * checks are in scripts/mcp-conformance.ts. Run with Node 24 from the repo:
 *
 *   MCP_SMOKE_URL=<APP_ORIGIN>/mcp node scripts/mcp-smoke.ts
 *   MCP_SMOKE_URL=<APP_ORIGIN>/mcp node scripts/mcp-smoke.ts --disabled
 *
 * Environment:
 *   MCP_SMOKE_URL         the MCP endpoint (required)
 *   MCP_SMOKE_TOKEN       an access token for the MCP resource; without it the
 *                         authenticated checks are skipped. Set it with
 *                         `read -s MCP_SMOKE_TOKEN; export MCP_SMOKE_TOKEN` so it
 *                         stays out of the shell history. Never printed.
 *   MCP_SMOKE_WEB_URL     the origin serving the protected resource metadata
 *   MCP_SMOKE_RESOURCE    the expected resource identifier (default MCP_SMOKE_URL)
 *   MCP_SMOKE_HEALTH_URL  the gateway's /healthz, when reachable
 *   MCP_SMOKE_SKIP_SEARCH "1" skips `search` (it may spend a query embedding)
 *
 * `--disabled` checks the health-only mode (flags off): /healthz says
 * "disabled", the endpoint and the PRM paths answer 404.
 * Exit code: 0 all checks passed or skipped, 1 a check failed, 2 bad usage.
 */
import {
  conformancePassed,
  formatResults,
  runConformance,
} from "./mcp-conformance.ts";

const env = (name: string) => process.env[name] || undefined;
const url = env("MCP_SMOKE_URL");
if (!url) {
  console.error(
    "MCP_SMOKE_URL is required (the MCP endpoint, e.g. <APP_ORIGIN>/mcp)",
  );
  process.exit(2);
}
const token = env("MCP_SMOKE_TOKEN");

try {
  const results = await runConformance({
    url,
    token,
    webUrl: env("MCP_SMOKE_WEB_URL"),
    resource: env("MCP_SMOKE_RESOURCE"),
    healthUrl: env("MCP_SMOKE_HEALTH_URL"),
    mode: process.argv.includes("--disabled") ? "disabled" : "enabled",
    search: env("MCP_SMOKE_SKIP_SEARCH") !== "1",
  });
  console.log(formatResults(results));
  const count = (status: string) =>
    results.filter((r) => r.status === status).length;
  const passed = conformancePassed(results);
  console.log(
    `RESULT ${passed ? "PASS" : "FAIL"} (${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped)`,
  );
  process.exit(passed ? 0 : 1);
} catch (error) {
  // Usage errors (bad URL, token over plain http); never the token itself.
  let message = `${(error as Error)?.name ?? "Error"}: ${(error as Error)?.message ?? ""}`;
  if (token) message = message.split(token).join("[redacted]");
  console.error(message);
  process.exit(2);
}
