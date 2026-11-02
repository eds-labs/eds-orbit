import { z } from "zod";
import { xOAuth, type OAuthTokenSet } from "@opencoredev/social-sdk/server";
import { scoped } from "../../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import { DomainError } from "../../../shared.ts";
import { appCredentials, redirectUri, type XAppSecret } from "./apps.ts";
import type { ConnectHandler } from "./connect.ts";
import { providerFailure, responseFailure } from "./errors.ts";
import { socialFetch, statusRecordingFetch } from "./http.ts";
import { beginOAuthState } from "./oauth-state.ts";
import { saveConnectedAccount } from "./store.ts";

// X accounts (ADR 0020): the SDK's OAuth provider runs the authorization
// with PKCE and the confidential client (Basic auth); Orbit reads the
// username and stores the tokens as the account connection's secret.

export const X_USER = "https://api.x.com/2/users/me";

const profile = z.object({ data: z.object({ id: z.string().min(1), name: z.string(), username: z.string().min(1) }) });

/** The secret of an X account connection. */
export const xAccountSecret = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).nullable(),
  expiresAt: z.string().nullable(),
  scopes: z.array(z.string()),
});
export type XAccountSecret = z.infer<typeof xAccountSecret>;

export function xAccountSecretOf(token: OAuthTokenSet): XAccountSecret {
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? null,
    expiresAt: token.expiresAt ?? null,
    scopes: [...(token.scopes ?? [])],
  };
}

function provider(
  app: XAppSecret,
  callback: string,
  sink?: (token: OAuthTokenSet) => void,
  fetch: typeof globalThis.fetch = socialFetch,
) {
  return xOAuth({
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    redirectUri: callback,
    fetch,
    ...(sink ? { credentialSink: { save: async ({ token }) => sink(token) } } : {}),
  });
}

async function readProfile(accessToken: string) {
  let response: Response;
  try {
    response = await socialFetch(`${X_USER}?user.fields=username,profile_image_url`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
  } catch (error) {
    throw providerFailure(error);
  }
  if (!response.ok) throw responseFailure(response);
  const parsed = profile.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new DomainError("SOCIAL_PROVIDER_UNAVAILABLE", 503);
  return parsed.data.data;
}

export const xConnect: ConnectHandler = {
  async begin(tx, scope) {
    const app = await appCredentials(tx, scope, "x");
    const callback = redirectUri(loadConfig(), "x");
    const started = await beginOAuthState(tx, scope, {
      platform: "x",
      appConnectionId: app.connectionId,
      redirectAfter: `/p/${scope.projectId}/social/accounts`,
    });
    try {
      const { authorizationUrl } = await provider(app.x!, callback).start({
        platforms: ["x"],
        capabilities: [],
        redirectUri: callback,
        state: started.state,
        codeChallenge: started.codeChallenge,
      });
      return { authorizeUrl: authorizationUrl };
    } catch (error) {
      throw providerFailure(error);
    }
  },

  async finish(scope, { callbackUrl, state, attempt }) {
    const app = await scoped(scope.workspaceId, scope.projectId, (tx) => appCredentials(tx, scope, "x"));
    if (app.connectionId !== attempt.appConnectionId) throw new DomainError("SOCIAL_APP_CHANGED", 409);
    const callback = redirectUri(loadConfig(), "x");
    let token: OAuthTokenSet | undefined;
    let userId: string;
    const recorder = statusRecordingFetch();
    try {
      const accounts = await provider(app.x!, callback, (t) => (token = t), recorder.fetch).complete({
        callbackUrl,
        attempt: {
          id: attempt.id,
          backend: "orbit",
          tenantId: scope.projectId,
          principalId: scope.userId,
          platforms: ["x"],
          capabilities: [],
          redirectUri: callback,
          state,
          codeVerifier: attempt.codeVerifier,
          createdAt: attempt.createdAt.toISOString(),
          expiresAt: attempt.expiresAt.toISOString(),
        },
      });
      userId = accounts[0]!.ref.accountId;
    } catch (error) {
      throw providerFailure(error, recorder.lastStatus());
    }
    if (!token) throw new DomainError("SOCIAL_PROVIDER_UNAVAILABLE", 503);
    const user = await readProfile(token.accessToken);
    if (user.id !== userId) throw new DomainError("SOCIAL_PROVIDER_REJECTED", 409);
    const secret = xAccountSecretOf(token);
    await saveConnectedAccount(scope, {
      platform: "x",
      externalId: user.id,
      handle: `@${user.username}`,
      displayName: user.name,
      secret: JSON.stringify(secret),
      config: { userId: user.id, appConnectionId: app.connectionId },
      settings: { refreshable: secret.refreshToken !== null },
    });
    return { accounts: 1 };
  },
};
