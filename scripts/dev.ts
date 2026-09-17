import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
if (!existsSync(".runtime/local.env"))
  throw new Error("Run node scripts/local-config.mjs first");
process.loadEnvFile(".runtime/local.env");
const webRequire = createRequire(resolve("apps/web/package.json"));
const runners = [
  spawn(process.execPath, ["--import", "tsx", "apps/api/src/main.ts"], {
    stdio: "inherit",
    env: process.env,
  }),
  spawn(process.execPath, ["--import", "tsx", "apps/worker/src/main.ts"], {
    stdio: "inherit",
    env: process.env,
  }),
  spawn(
    process.execPath,
    [
      webRequire.resolve("next/dist/bin/next"),
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      "4310",
    ],
    { cwd: resolve("apps/web"), stdio: "inherit", env: process.env },
  ),
];
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    runners.forEach((p) => p.kill("SIGTERM"));
    process.exit(0);
  });
for (const child of runners)
  child.on("error", () => {
    console.error("Orbit local service could not start");
    runners.forEach((p) => p.kill("SIGTERM"));
    process.exitCode = 1;
  });
