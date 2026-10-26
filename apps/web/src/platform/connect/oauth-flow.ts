// The browser side of the OAuth authorization an MCP client starts (Track M,
// WP-M1). Better Auth sends the browser to /connect/login and /connect with a
// signed query; this module only carries that query to the API and follows the
// redirects the API returns. The API verifies the signature and decides
// everything security-relevant; nothing here is trusted by the server.

type Post = <T>(path: string, data: unknown) => Promise<T>;
type Navigate = (url: string) => void;

/**
 * The part of a page query that Better Auth signed: `sig`, `ba_param` and
 * every parameter `ba_param` names. Anything else on the URL (a tracking
 * parameter, say) is dropped. Null without a complete signed query.
 */
export function signedQuery(search: string): string | null {
  const params = new URLSearchParams(search);
  if (!params.has("sig") || !params.has("client_id")) return null;
  const names = new Set(params.getAll("ba_param"));
  if (!names.size) return null;
  const signed = new URLSearchParams();
  for (const [key, value] of params)
    if (key === "sig" || key === "ba_param" || names.has(key))
      signed.append(key, value);
  return signed.toString();
}

const UNSAFE_SCHEMES = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "blob:",
  "about:",
]);

/**
 * Whether the browser may be sent to `url`: a path of this site or an absolute
 * URL, including the private-use schemes native clients register, but never a
 * script, data or protocol-relative URL.
 */
export function isSafeRedirect(url: unknown): url is string {
  if (typeof url !== "string" || !url || /[\u0000-\u001f]/.test(url))
    return false;
  if (url.startsWith("//") || url.startsWith("/\\")) return false;
  try {
    return !UNSAFE_SCHEMES.has(new URL(url, "https://orbit.invalid").protocol);
  } catch {
    return false;
  }
}

/** Better Auth's continuation `{ redirect: true, url }`, if the answer is one. */
export function redirectTarget(result: unknown): string | null {
  const answer = result as { redirect?: unknown; url?: unknown } | null;
  return answer?.redirect === true && isSafeRedirect(answer.url)
    ? answer.url
    : null;
}

/**
 * Signs in. With a signed query the body carries it as `oauth_query`, and the
 * answer says where the authorization continues; without one the body is the
 * plain credentials.
 */
export async function signIn(input: {
  post: Post;
  navigate: Navigate;
  email: string;
  password: string;
  oauthQuery: string | null;
}) {
  const { email, password, oauthQuery } = input;
  const result = await input.post(
    "/auth/sign-in/email",
    oauthQuery
      ? { email, password, oauth_query: oauthQuery }
      : { email, password },
  );
  const next = oauthQuery ? redirectTarget(result) : null;
  if (next) input.navigate(next);
}

export type Selection = {
  workspaceId: string;
  projectIds: string[];
  allCurrentProjects: boolean;
};

/**
 * Better Auth marks the consent redirect with `ba_pl`; the selection step
 * comes first, so consent is shown only when the session also has a selection.
 * A wrong guess cannot grant anything: the consent route refuses without one.
 */
export function connectStep(
  oauthQuery: string,
  selection: Selection | null,
): "select" | "consent" {
  return selection && new URLSearchParams(oauthQuery).has("ba_pl")
    ? "consent"
    : "select";
}

/** Records the selection, then follows to the next step or the client. */
export async function submitSelection(
  post: Post,
  navigate: Navigate,
  input: {
    oauthQuery: string;
    workspaceId: string;
    projectIds: string[] | "all_current";
  },
) {
  const { next } = await post<{ next?: unknown }>(
    "/mcp-connect/selection",
    input,
  );
  if (!isSafeRedirect(next)) throw new Error("OAUTH_NO_REDIRECT");
  navigate(next);
}

/**
 * Optional scopes that start unchecked: accepted only when the user ticks
 * them. Old grants gain none of them; a client reconnects to ask.
 */
export const EXPLICIT_SCOPES = [
  "orbit:write",
  "orbit:support",
  "orbit:finance.read",
  "orbit:finance.extract",
  "orbit:work",
  "orbit:work.pm",
  "orbit:work.coding",
  "orbit:issues",
] as const;

/** The scopes to accept: the requested ones in order, minus an unticked propose. */
export function acceptedScopes(
  requested: readonly string[],
  propose: boolean,
  extra: readonly string[] = [],
) {
  return requested.filter(
    (scope) =>
      (scope !== "orbit:propose" || propose) &&
      (!(EXPLICIT_SCOPES as readonly string[]).includes(scope) ||
        extra.includes(scope)),
  );
}

/**
 * Answers the consent: the accepted scopes, or none for a denial. The body
 * never carries claims. Follows the redirect, which leaves Orbit.
 */
export async function submitConsent(
  post: Post,
  navigate: Navigate,
  input: { oauthQuery: string; accept: boolean; scopes: string[] },
) {
  const { redirect } = await post<{ redirect?: unknown }>(
    "/mcp-connect/consent",
    {
      oauthQuery: input.oauthQuery,
      accept: input.accept,
      scopes: input.accept ? input.scopes : [],
    },
  );
  if (!isSafeRedirect(redirect)) throw new Error("OAUTH_NO_REDIRECT");
  navigate(redirect);
}

/** The host of a client_id that is a URL (a metadata document), else the id itself. */
export function clientHost(clientId: string) {
  try {
    return new URL(clientId).host || clientId;
  } catch {
    return clientId;
  }
}

/** The hostname of a website the client names, if it is an http(s) URL. */
export function websiteHost(uri: string | null | undefined) {
  if (!uri) return null;
  try {
    const url = new URL(uri);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.host
      : null;
  } catch {
    return null;
  }
}
