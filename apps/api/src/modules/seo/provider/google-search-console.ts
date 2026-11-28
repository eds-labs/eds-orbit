import { randomBytes } from "node:crypto";
import { z } from "zod";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  connectionSecret,
  grantedConnections,
} from "../../../platform/connections/central.ts";
import {
  createProjectConnection,
  revokeProjectConnection,
  withProjectSecret,
} from "../../../platform/connections/project-secrets.ts";
import { openSecret } from "../../../platform/connections/secrets.ts";
import { DomainError } from "../../../platform/shared.ts";
import { actorScope } from "../../../platform/tenancy/member-scope.ts";
import { requireSeoAccess } from "../gate.ts";
import { SEO_MODULE_ID } from "../manifest.ts";
import { SEO_MANAGE } from "../permissions.ts";
import {
  GOOGLE_SEARCH_CONSOLE,
  googleAccountProvider,
  googleAccountPurpose,
  googleAppCredentials,
  googleReadyAppIds,
  googleRedirectUri,
} from "./google-app.ts";
import {
  GOOGLE_SEARCH_CONSOLE_SCOPE,
  exchangeGoogleCode,
  listGoogleProperties,
  prepareGoogleQuery,
  prepareGoogleTokenRefresh,
} from "./google-http.ts";
import {
  beginGoogleState,
  consumeGoogleState,
  type ConsumedGoogleSearchConsoleState,
} from "./google-state.ts";
import type { SeoOAuthProvider } from "./types.ts";

const accountConfig = z.object({ appConnectionId: z.uuid() });
const accountSecret = z.object({
  clientId: z.string().min(1),
  refreshToken: z.string().min(1).max(8192),
});
const reconnect = () =>
  new DomainError("SEO_CONNECTION_RECONNECT_REQUIRED", 409);

async function accounts(tx: DbTx, scope: Scope) {
  const grants = await grantedConnections(tx, scope, {
    provider: googleAccountProvider,
    purpose: googleAccountPurpose,
    module: SEO_MODULE_ID,
  });
  if (grants.length === 0) return [];
  const local = await tx.connection.findMany({
    where: {
      id: { in: grants.map((item) => item.connection.id) },
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      provider: googleAccountProvider,
      scope: "project",
    },
    select: { id: true },
  });
  const ownIds = new Set(local.map(({ id }) => id));
  return grants.filter(({ connection }) => ownIds.has(connection.id));
}

async function requireAccount(tx: DbTx, scope: Scope, connectionId: string) {
  const granted = (await accounts(tx, scope)).find(
    (item) => item.connection.id === connectionId,
  );
  if (!granted) throw new DomainError("SEO_CONNECTION_NOT_FOUND", 404);
  return granted.connection;
}

async function prepareToken(tx: DbTx, scope: Scope, connectionId: string) {
  const connection = await requireAccount(tx, scope, connectionId);
  const config = accountConfig.safeParse(connection.config);
  if (!config.success) throw reconnect();
  const app = await googleAppCredentials(
    tx,
    scope,
    config.data.appConnectionId,
  );
  const raw = await connectionSecret(tx, connection.id);
  if (!raw) throw reconnect();
  let saved: z.infer<typeof accountSecret>;
  try {
    saved = accountSecret.parse(JSON.parse(raw));
  } catch {
    throw reconnect();
  }
  if (saved.clientId !== app.clientId) throw reconnect();
  return prepareGoogleTokenRefresh(connection.id, app, saved.refreshToken);
}

async function currentOwner(tx: DbTx, scope: Scope) {
  const current = await actorScope(
    scope.workspaceId,
    scope.projectId,
    scope.userId,
  );
  if (!current) throw new DomainError("NOT_FOUND", 404);
  await requireSeoAccess(tx, current, SEO_MANAGE);
  return current;
}

export const googleSearchConsoleProvider: SeoOAuthProvider<ConsumedGoogleSearchConsoleState> =
  {
    id: GOOGLE_SEARCH_CONSOLE,
    async status(tx, scope) {
      const [availableApps, knownAccounts] = await Promise.all([
        googleReadyAppIds(tx, scope),
        accounts(tx, scope),
      ]);
      return {
        appReady: availableApps.size > 0,
        connections: knownAccounts.map(({ connection }) => ({
          id: connection.id,
          label: connection.label,
          unavailable: !availableApps.has(
            String(connection.config.appConnectionId),
          ),
        })),
      };
    },

    async beginConnect(tx, scope, accountConnectionId) {
      if (accountConnectionId)
        await requireAccount(tx, scope, accountConnectionId);
      const app = await googleAppCredentials(tx, scope);
      const { state, challenge } = await beginGoogleState(
        tx,
        scope,
        app.connectionId,
        accountConnectionId,
      );
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: app.clientId,
        redirect_uri: googleRedirectUri(),
        response_type: "code",
        scope: GOOGLE_SEARCH_CONSOLE_SCOPE,
        access_type: "offline",
        prompt: "consent select_account",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      }).toString();
      return { authorizeUrl: url.href };
    },

    consumeState: consumeGoogleState,

    async finishConnect(scope, { code, attempt }) {
      if (
        scope.workspaceId !== attempt.workspaceId ||
        scope.projectId !== attempt.projectId ||
        scope.userId !== attempt.userId
      )
        throw new DomainError("SEO_OAUTH_STATE_INVALID", 403);

      const app = await scoped(
        scope.workspaceId,
        scope.projectId,
        async (tx) => {
          await currentOwner(tx, scope);
          return googleAppCredentials(tx, scope, attempt.appConnectionId);
        },
      );
      const refreshToken = await exchangeGoogleCode(app, {
        code,
        verifier: openSecret(attempt.verifier),
        redirectUri: googleRedirectUri(),
      });

      return scoped(scope.workspaceId, scope.projectId, async (tx) => {
        const owner = await currentOwner(tx, scope);
        const currentApp = await googleAppCredentials(
          tx,
          owner,
          attempt.appConnectionId,
        );
        if (app.clientId !== currentApp.clientId)
          throw new DomainError("SEO_GOOGLE_APP_CHANGED", 409);

        const config = { appConnectionId: currentApp.connectionId };
        const secret = JSON.stringify({
          clientId: currentApp.clientId,
          refreshToken,
        });
        if (attempt.accountConnectionId) {
          const connection = await requireAccount(
            tx,
            owner,
            attempt.accountConnectionId,
          );
          await withProjectSecret(
            owner,
            { moduleId: SEO_MODULE_ID, connectionId: connection.id },
            async () => ({ result: null, secret, config }),
          );
          return { connectionId: connection.id };
        }
        const { connectionId } = await createProjectConnection(owner, {
          moduleId: SEO_MODULE_ID,
          provider: googleAccountProvider,
          label: `Google Search Console · ${randomBytes(4).toString("hex")}`,
          config,
          secret,
          purposes: [googleAccountPurpose],
        });
        return { connectionId };
      });
    },

    async disconnect(tx, scope, connectionId) {
      const owner = await currentOwner(tx, scope);
      await requireAccount(tx, owner, connectionId);
      await revokeProjectConnection(owner, {
        moduleId: SEO_MODULE_ID,
        connectionId,
        reason: "user_disconnected",
      });
    },

    async preparePropertyListing(tx, scope, connectionId) {
      const accessToken = await prepareToken(tx, scope, connectionId);
      return async () => listGoogleProperties(await accessToken());
    },

    async preparePerformance(tx, scope, input) {
      const query = prepareGoogleQuery(input);
      const accessToken = await prepareToken(tx, scope, input.connectionId);
      return async () => query(await accessToken());
    },
  };
