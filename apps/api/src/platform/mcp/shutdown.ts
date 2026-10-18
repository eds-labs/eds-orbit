/**
 * Shutdown of the gateway process (Track M, WP-M2): runs the close steps once
 * however many signals arrive, logs a failing step by error name only, and
 * always ends with an exit (0 when every step closed, 1 otherwise).
 */
export function makeShutdown(options: {
  /** Closed in order, for example the HTTP app, then the database. */
  steps: readonly (() => Promise<unknown>)[];
  exit: (code: number) => void;
  log: (...args: unknown[]) => void;
}): () => Promise<void> {
  let running: Promise<void> | undefined;
  return () =>
    (running ??= (async () => {
      let code = 0;
      for (const step of options.steps) {
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
      options.exit(code);
    })());
}
