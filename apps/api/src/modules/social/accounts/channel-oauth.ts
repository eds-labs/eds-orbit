import { z } from "zod";
import { scoped } from "../../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import { DomainError } from "../../../shared.ts";
import { appCredentials, redirectUri, type ChannelAppSecret } from "./apps.ts";
import type { ConnectHandler } from "./connect.ts";
import { providerFailure, responseFailure } from "./errors.ts";
import { socialFetch } from "./http.ts";
import { beginOAuthState } from "./oauth-state.ts";
import { saveConnectedAccount } from "./store.ts";

export type ChannelApp = "linkedin" | "youtube" | "tiktok";

const providers = {
  linkedin: {
    authorize: "https://www.linkedin.com/oauth/v2/authorization",
    token: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["r_organization_admin", "w_organization_social"],
  },
  tiktok: {
    authorize: "https://www.tiktok.com/v2/auth/authorize/",
    token: "https://open.tiktokapis.com/v2/oauth/token/",
    scopes: ["user.info.basic", "user.info.profile", "video.upload"],
  },
  youtube: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.readonly",
    ],
  },
} as const;

export const LINKEDIN_REST = "https://api.linkedin.com/rest";
export const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";

export function linkedinHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Linkedin-Version": "202610",
    "X-Restli-Protocol-Version": "2.0.0",
    Accept: "application/json",
  };
}

const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.int().positive().max(31_536_000),
  scope: z.string().optional(),
});

export const channelAccountSecret = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).nullable(),
  expiresAt: z.iso.datetime(),
});
export type ChannelAccountSecret = z.infer<typeof channelAccountSecret>;

async function tokenRequest(
  platform: ChannelApp,
  app: ChannelAppSecret,
  fields: Record<string, string>,
  previous?: ChannelAccountSecret,
): Promise<ChannelAccountSecret> {
  let response: Response;
  try {
    response = await socialFetch(providers[platform].token, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        [platform === "tiktok" ? "client_key" : "client_id"]: app.clientId,
        client_secret: app.clientSecret,
        ...fields,
      }),
    });
  } catch (error) {
    throw providerFailure(error);
  }
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    if (json?.error === "invalid_client")
      throw new DomainError("SOCIAL_APP_INVALID", 409);
    if (json?.error === "invalid_grant")
      throw new DomainError("SOCIAL_ACCOUNT_RECONNECT_REQUIRED", 409);
    throw responseFailure(response);
  }
  const token = tokenResponse.safeParse(json);
  if (!token.success) throw new DomainError("SOCIAL_PROVIDER_UNAVAILABLE", 503);
  if (platform === "tiktok" && !previous && !token.data.scope)
    throw new DomainError("SOCIAL_PROVIDER_REJECTED", 409);
  if (token.data.scope) {
    const scopes = token.data.scope.split(/[ ,]+/);
    if (!providers[platform].scopes.every((scope) => scopes.includes(scope)))
      throw new DomainError("SOCIAL_PROVIDER_REJECTED", 409);
  }
  return {
    accessToken: token.data.access_token,
    refreshToken: token.data.refresh_token ?? previous?.refreshToken ?? null,
    expiresAt: new Date(
      Date.now() + token.data.expires_in * 1000,
    ).toISOString(),
  };
}

export async function refreshChannelToken(
  platform: ChannelApp,
  app: ChannelAppSecret,
  secret: ChannelAccountSecret,
) {
  if (!secret.refreshToken)
    throw new DomainError("SOCIAL_ACCOUNT_RECONNECT_REQUIRED", 409);
  return tokenRequest(
    platform,
    app,
    { grant_type: "refresh_token", refresh_token: secret.refreshToken },
    secret,
  );
}

async function read(url: string, headers: Record<string, string>) {
  let response: Response;
  try {
    response = await socialFetch(url, { headers });
  } catch (error) {
    throw providerFailure(error);
  }
  if (!response.ok) throw responseFailure(response);
  return response.json().catch(() => null);
}

const organizationAcl = z.object({
  elements: z.array(
    z.object({ organization: z.string(), role: z.string(), state: z.string() }),
  ),
  paging: z
    .object({ links: z.array(z.object({ rel: z.string() })).optional() })
    .optional(),
});
const linkedinOrganization = z.object({
  id: z.int().positive(),
  localizedName: z.string().min(1),
  vanityName: z.string().optional(),
});
const youtubeChannels = z.object({
  items: z.array(
    z.object({
      id: z.string().regex(/^UC[\w-]+$/),
      snippet: z.object({
        title: z.string().min(1),
        customUrl: z.string().optional(),
      }),
    }),
  ),
  nextPageToken: z.string().optional(),
});

export async function readChannel(
  platform: ChannelApp,
  token: string,
  targetId: string,
) {
  if (platform === "linkedin") {
    const headers = linkedinHeaders(token);
    const organization = `urn:li:organization:${targetId}`;
    for (let start = 0; start < 1000; start += 100) {
      const acls = organizationAcl.safeParse(
        await read(
          `${LINKEDIN_REST}/organizationAcls?q=roleAssignee&state=APPROVED&start=${start}&count=100`,
          headers,
        ),
      );
      if (!acls.success)
        throw new DomainError("SOCIAL_PROVIDER_UNAVAILABLE", 503);
      const allowed = acls.data.elements.some(
        (entry) =>
          entry.organization === organization &&
          entry.state === "APPROVED" &&
          entry.role === "ADMINISTRATOR",
      );
      if (allowed) {
        const page = linkedinOrganization.safeParse(
          await read(`${LINKEDIN_REST}/organizations/${targetId}`, headers),
        );
        if (!page.success || String(page.data.id) !== targetId)
          throw new DomainError("SOCIAL_PROVIDER_UNAVAILABLE", 503);
        return {
          id: targetId,
          handle: page.data.vanityName ?? targetId,
          name: page.data.localizedName,
        };
      }
      if (
        !acls.data.paging?.links?.some(({ rel }) => rel === "next") &&
        acls.data.elements.length < 100
      )
        break;
    }
  } else if (platform === "tiktok") {
    const body = await read(
      "https://open.tiktokapis.com/v2/user/info/?fields=username,display_name",
      { Authorization: `Bearer ${token}` },
    );
    const profile = body?.error?.code === "ok" ? body.data?.user : undefined;
    const username =
      typeof profile?.username === "string"
        ? `@${profile.username.toLowerCase()}`
        : null;
    if (username && username === targetId.toLowerCase())
      return {
        id: username,
        handle: username,
        name:
          typeof profile.display_name === "string"
            ? profile.display_name
            : username,
      };
  } else {
    const url = new URL(`${YOUTUBE_API}/channels`);
    url.search = new URLSearchParams({
      part: "snippet",
      mine: "true",
      maxResults: "50",
    }).toString();
    const channels = youtubeChannels.safeParse(
      await read(url.href, { Authorization: `Bearer ${token}` }),
    );
    if (!channels.success)
      throw new DomainError("SOCIAL_PROVIDER_UNAVAILABLE", 503);
    // uploads belong to the identity of the token; require one unambiguous channel.
    const [channel] = channels.data.items;
    if (
      channel?.id === targetId &&
      channels.data.items.length === 1 &&
      !channels.data.nextPageToken
    )
      return {
        id: channel.id,
        handle: channel.snippet.customUrl ?? channel.id,
        name: channel.snippet.title,
      };
  }
  throw new DomainError("SOCIAL_PROVIDER_REJECTED", 409);
}

export function channelConnect(platform: ChannelApp): ConnectHandler {
  return {
    async begin(tx, scope) {
      const app = await appCredentials(tx, scope, platform);
      const callback = redirectUri(loadConfig(), platform);
      const started = await beginOAuthState(tx, scope, {
        platform,
        appConnectionId: app.connectionId,
        redirectAfter: `/p/${scope.projectId}/social/accounts`,
      });
      const url = new URL(providers[platform].authorize);
      url.search = new URLSearchParams({
        [platform === "tiktok" ? "client_key" : "client_id"]:
          app.channel!.clientId,
        redirect_uri: callback,
        response_type: "code",
        scope: providers[platform].scopes.join(
          platform === "tiktok" ? "," : " ",
        ),
        state: started.state,
        ...(platform === "youtube"
          ? {
              access_type: "offline",
              prompt: "consent select_account",
              code_challenge: started.codeChallenge,
              code_challenge_method: "S256",
            }
          : {}),
      }).toString();
      return { authorizeUrl: url.href };
    },
    async finish(scope, { callbackUrl, attempt }) {
      const app = await scoped(scope.workspaceId, scope.projectId, (tx) =>
        appCredentials(tx, scope, platform),
      );
      if (app.connectionId !== attempt.appConnectionId)
        throw new DomainError("SOCIAL_APP_CHANGED", 409);
      const channelApp = app.channel!;
      const code = new URL(callbackUrl).searchParams.get("code");
      if (!code) throw new DomainError("SOCIAL_OAUTH_CANCELLED", 409);
      const token = await tokenRequest(platform, channelApp, {
        grant_type: "authorization_code",
        redirect_uri: redirectUri(loadConfig(), platform),
        code,
        ...(platform === "youtube"
          ? { code_verifier: attempt.codeVerifier }
          : {}),
      });
      if (platform !== "linkedin" && !token.refreshToken)
        throw new DomainError("SOCIAL_ACCOUNT_RECONNECT_REQUIRED", 409);
      const channel = await readChannel(
        platform,
        token.accessToken,
        channelApp.targetId,
      );
      await saveConnectedAccount(scope, {
        platform,
        externalId: channel.id,
        handle: channel.handle,
        displayName: channel.name,
        secret: JSON.stringify(token),
        config: {
          appConnectionId: app.connectionId,
          ...(platform === "tiktok" ? { inbox: true } : {}),
        },
        settings: {
          refreshable: token.refreshToken !== null,
          ...(platform === "tiktok" ? { tiktokInbox: true } : {}),
        },
      });
      return { accounts: 1 };
    },
  };
}
