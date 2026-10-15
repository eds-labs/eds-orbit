import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { Auth } from "../tenancy/auth.ts";

/** What a project action receives, after the route checked its permission. */
export type ActionContext = {
  scope: Scope;
  /** The parsed request body (an object); each handler validates its fields. */
  input: Record<string, any>;
  /** The API's configuration, read once at start. */
  config: ReturnType<typeof loadConfig>;
  auth: Auth;
};

/**
 * One handler of POST /api/projects/:projectId/actions/:action (WP2.1f).
 * Most run inside the project transaction the route opens (`shared`); a few
 * open their own transactions or none, because they call a provider or read
 * a Drive asset that needs the project lock themselves (`own`).
 */
export type ActionHandler =
  | {
      transaction: "shared";
      run(tx: DbTx, ctx: ActionContext): Promise<unknown>;
    }
  | { transaction: "own"; run(ctx: ActionContext): Promise<unknown> };

export const sharedTransaction = (
  run: (tx: DbTx, ctx: ActionContext) => Promise<unknown>,
): ActionHandler => ({ transaction: "shared", run });
export const ownTransaction = (
  run: (ctx: ActionContext) => Promise<unknown>,
): ActionHandler => ({ transaction: "own", run });
