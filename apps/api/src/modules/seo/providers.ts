import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../../shared.ts";
import {
  GOOGLE_SEARCH_CONSOLE_CALLBACK,
  googleSearchConsoleProjectOfState,
  googleSearchConsoleProvider,
  type SeoOAuthProvider,
  type SeoProvider,
} from "./provider/index.ts";

type OAuthRegistration = {
  callbackPath: string;
  settingsSection: string;
  projectOfState(state: string): string;
  beginConnect(
    tx: DbTx,
    scope: Scope,
    accountConnectionId?: string,
  ): Promise<{ authorizeUrl: string }>;
  claim(
    tx: DbTx,
    scope: Scope,
    state: string,
  ): Promise<(code: string) => Promise<unknown>>;
};

function oauth<Attempt>(
  provider: SeoOAuthProvider<Attempt>,
  config: Pick<
    OAuthRegistration,
    "callbackPath" | "settingsSection" | "projectOfState"
  >,
): OAuthRegistration {
  return {
    ...config,
    beginConnect: (tx, scope, connectionId) =>
      provider.beginConnect(tx, scope, connectionId),
    async claim(tx, scope, state) {
      const attempt = await provider.consumeState(tx, scope, state);
      return (code) => provider.finishConnect(scope, { code, attempt });
    },
  };
}

export const seoProviders: readonly (SeoProvider & {
  label: string;
  oauth?: OAuthRegistration;
})[] = [
  {
    ...googleSearchConsoleProvider,
    label: "Google Search Console",
    oauth: oauth(googleSearchConsoleProvider, {
      callbackPath: GOOGLE_SEARCH_CONSOLE_CALLBACK,
      settingsSection: "search-console",
      projectOfState: googleSearchConsoleProjectOfState,
    }),
  },
];

export function requireSeoProvider(id: string) {
  const provider = seoProviders.find((entry) => entry.id === id);
  if (!provider) throw new DomainError("SEO_PROVIDER_NOT_FOUND", 404);
  return provider;
}
