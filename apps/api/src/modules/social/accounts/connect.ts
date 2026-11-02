import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import type { SocialApp } from "./apps.ts";
import type { consumeOAuthState, OAuthPlatform } from "./oauth-state.ts";
import { metaConnect } from "./meta.ts";
import { xConnect } from "./x.ts";

// Connecting accounts over OAuth (ADR 0020): one handler per developer app.
// The routes own the state checks; a handler starts the authorization and
// turns a consumed state plus the provider's callback into accounts.

export type ConsumedState = Awaited<ReturnType<typeof consumeOAuthState>>;

export type ConnectHandler = {
  begin(tx: DbTx, scope: Scope): Promise<{ authorizeUrl: string }>;
  finish(
    scope: Scope,
    input: { callbackUrl: string; state: string; attempt: ConsumedState },
  ): Promise<{ accounts: number }>;
};

const handlers: Record<SocialApp, ConnectHandler> = { meta: metaConnect, x: xConnect };
const overrides: Partial<Record<SocialApp, ConnectHandler>> = {};

/** The OAuth state platform of a developer app. */
export const oauthPlatform = (app: SocialApp): OAuthPlatform => (app === "meta" ? "facebook" : "x");

export function connectHandler(app: SocialApp): ConnectHandler {
  return overrides[app] ?? handlers[app];
}

/** Test hook: replaces an app's handler; null restores it. */
export function setConnectHandlerForTests(app: SocialApp, handler: ConnectHandler | null) {
  if (handler) overrides[app] = handler;
  else delete overrides[app];
}
