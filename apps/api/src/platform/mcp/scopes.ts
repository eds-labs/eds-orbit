/**
 * Explicit content scopes of the MCP gateway. Each is an extra, initially
 * unchecked consent on top of the risk scope (`orbit:read`, `orbit:propose`,
 * `orbit:write`); a tool lists the ones it needs in `mcpScopes`, and every
 * listed scope is required (all-of). Old grants gain none of them: a client
 * reconnects and the user ticks the scope on Orbit's consent screen.
 */

/** Ticket content (Support). */
export const SUPPORT_SCOPE = "orbit:support";
/** Finance documents, extraction results and processing state (read). */
export const FINANCE_READ_SCOPE = "orbit:finance.read";
/** Proposing a paid finance extraction retry (with `orbit:propose`). */
export const FINANCE_EXTRACT_SCOPE = "orbit:finance.extract";
/** Project management: initiatives, milestones and tasks (ADR 0016). */
export const WORK_SCOPE = "orbit:work";
/** Asking the AI project manager for paid plans and reports (ADR 0017). */
export const WORK_PM_SCOPE = "orbit:work.pm";
/** Proposing coding work orders for external coding agents (ADR 0017). */
export const WORK_CODING_SCOPE = "orbit:work.coding";

/**
 * The content scope a delegated work order (MCP 2.0 task) needs for a
 * module: a task that names the module may read that module's content
 * through the native assistant, so it needs the same consent as a direct read.
 */
export const MODULE_CONTENT_SCOPES: Readonly<Record<string, string>> = {
  support: SUPPORT_SCOPE,
  finance: FINANCE_READ_SCOPE,
  work: WORK_SCOPE,
};

/** True when a task's modules need a content scope the principal lacks. */
export function lacksModuleConsent(
  modules: readonly string[],
  scopes: ReadonlySet<string>,
) {
  return modules.some((m) => {
    const needed = MODULE_CONTENT_SCOPES[m];
    return needed !== undefined && !scopes.has(needed);
  });
}
