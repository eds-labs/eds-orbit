/** How long the close steps may take before the process exits anyway (WP-M5). */
export const MCP_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Shutdown of the gateway process (Track M, WP-M2): runs the close steps once
 * however many signals arrive, logs a failing step by error name only, and
 * always ends with one exit (0 when every step closed, 1 otherwise). A step
 * that hangs (for example `app.close()` waiting on a stuck request) cannot
 * block it: after `timeoutMs` the process exits 1 (D-M5-6). The timer is
 * unref'd, so it never keeps an otherwise finished process alive.
 */
export function makeShutdown(options: {
  /** Closed in order, for example the HTTP app, then the database. */
  steps: readonly (() => Promise<unknown>)[];
  exit: (code: number) => void;
  log: (...args: unknown[]) => void;
  /** Overrides MCP_SHUTDOWN_TIMEOUT_MS. */
  timeoutMs?: number;
}): () => Promise<void> {
  let running: Promise<void> | undefined;
  let exited = false;
  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    options.exit(code);
  };
  return () =>
    (running ??= (async () => {
      const timer = setTimeout(() => {
        options.log("MCP gateway shutdown timed out; forcing exit");
        exitOnce(1);
      }, options.timeoutMs ?? MCP_SHUTDOWN_TIMEOUT_MS);
      timer.unref();
      let code = 0;
      for (const step of options.steps) {
        if (exited) break;
        try {
          await step();
        } catch (error) {
          code = 1;
          options.log(
            "MCP gateway shutdown step failed",
            (error as Error | undefined)?.name ?? "unknown",
          );
        }
      }
      clearTimeout(timer);
      exitOnce(code);
    })());
}
