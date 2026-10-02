import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A real worker process for one test workspace in test execution: its own
 * queue namespace and health file, no external writes and no model key.
 */
export function workerProcess(prefix: string) {
  let worker: ChildProcess | undefined;
  let diagnostic = "";
  const queueNamespace = `${prefix}-${randomUUID().slice(0, 8)}`;
  const healthDir = join(tmpdir(), queueNamespace);
  const healthFile = join(healthDir, "worker.json");
  function start(workspaceId: string) {
    worker = spawn(
      process.execPath,
      ["--import", "tsx", "apps/worker/src/main.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: process.env.TEST_DATABASE_URL,
          AUTH_DATABASE_URL: process.env.TEST_AUTH_DATABASE_URL,
          QUEUE_NAMESPACE: queueNamespace,
          PUBLISHER_INSTANCE_ID: queueNamespace,
          WORKER_HEALTH_FILE: healthFile,
          WORKER_WORKSPACE_ALLOWLIST: workspaceId,
          EXECUTION_MODE: "test",
          ENABLE_EXTERNAL_WRITES: "false",
          LIVE_RAG_EVAL_PASSED: "false",
          OPENAI_API_KEY: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    worker.stderr!.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-3000);
    });
  }
  async function stop(crash = false) {
    if (!worker || worker.exitCode !== null) return;
    const p = worker;
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        p.kill("SIGKILL");
        done();
      }, 3000);
      p.once("exit", () => {
        clearTimeout(timer);
        done();
      });
      p.kill(crash ? "SIGKILL" : "SIGTERM");
    });
    worker = undefined;
  }
  async function waitFor<T>(check: () => Promise<T | false>, timeout = 30000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const result = await check();
      if (result) return result;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`${prefix} worker timeout ${diagnostic}`);
  }
  async function cleanup() {
    await stop();
    await rm(healthDir, { recursive: true, force: true });
  }
  return { start, stop, waitFor, cleanup, healthFile };
}
