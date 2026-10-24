import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { labels, type Locale } from "@/lib/i18n";
import {
  ConnectErrorPage,
  ConnectProblem,
  ConsentStep,
  SelectStep,
} from "./connect-view";
import {
  acceptedScopes,
  connectStep,
  redirectTarget,
  signedQuery,
  signIn,
  submitConsent,
  submitSelection,
} from "./oauth-flow";

const t = (locale: Locale) => (key: keyof typeof labels.en) =>
  labels[locale][key];

// The query Better Auth puts on the login page: the authorization request, its
// signature and the names the signature covers (all of them, plus ba_param).
const SIGNED =
  "client_id=https%3A%2F%2Fapp.example%2Fclient.json&scope=openid+orbit%3Aread&state=s1&exp=1900000000&ba_iat=1800000000000&ba_param=ba_iat&ba_param=ba_param&ba_param=client_id&ba_param=exp&ba_param=scope&ba_param=state&sig=abc";

describe("login continues a pending authorization", () => {
  it("takes the signed part of the page query", () => {
    expect(signedQuery(`?${SIGNED}`)).toBe(SIGNED);
    // A parameter the signature does not cover is not part of the query.
    expect(signedQuery(`?${SIGNED}&utm=x&extra=1`)).toBe(SIGNED);
    expect(signedQuery("")).toBeNull();
    expect(signedQuery("?client_id=x")).toBeNull();
    expect(signedQuery("?client_id=x&sig=abc")).toBeNull();
  });

  it("sends oauth_query with the credentials and follows the returned redirect", async () => {
    const post = vi.fn().mockResolvedValue({
      redirect: true,
      url: `/connect?${SIGNED}&ba_pl=sid`,
    });
    const navigate = vi.fn();
    await signIn({
      post,
      navigate,
      email: "a@example.invalid",
      password: "pw",
      oauthQuery: SIGNED,
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/auth/sign-in/email", {
      email: "a@example.invalid",
      password: "pw",
      oauth_query: SIGNED,
    });
    expect(navigate).toHaveBeenCalledWith(`/connect?${SIGNED}&ba_pl=sid`);
  });

  it("without a signed query the body is exactly the plain credentials", async () => {
    const post = vi.fn().mockResolvedValue({ redirect: false, user: {} });
    const navigate = vi.fn();
    await signIn({
      post,
      navigate,
      email: "a@example.invalid",
      password: "pw",
      oauthQuery: null,
    });
    const body = post.mock.calls[0]![1];
    expect(JSON.stringify(body)).toBe(
      JSON.stringify({ email: "a@example.invalid", password: "pw" }),
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("never follows a script or data URL", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,x",
      "//evil.example/x",
      "vbscript:x",
    ])
      expect(redirectTarget({ redirect: true, url })).toBeNull();
    expect(redirectTarget({ redirect: true })).toBeNull();
    expect(redirectTarget({ url: "/connect?x=1" })).toBeNull();
    expect(
      redirectTarget({ redirect: true, url: "https://app.example/cb?code=c" }),
    ).toBe("https://app.example/cb?code=c");
    // Native clients use private-use schemes.
    expect(
      redirectTarget({ redirect: true, url: "cursor://mcp/cb?code=c" }),
    ).toBe("cursor://mcp/cb?code=c");
  });
});

describe("selection and consent requests", () => {
  it("shows the consent step once the session has a selection and the query says so", () => {
    const selection = {
      workspaceId: "w",
      projectIds: ["p"],
      allCurrentProjects: false,
    };
    expect(connectStep(`${SIGNED}&ba_pl=sid`, selection)).toBe("consent");
    expect(connectStep(SIGNED, selection)).toBe("select");
    expect(connectStep(`${SIGNED}&ba_pl=sid`, null)).toBe("select");
  });

  it("posts the selection and follows next", async () => {
    const post = vi.fn().mockResolvedValue({ next: `/connect?${SIGNED}` });
    const navigate = vi.fn();
    await submitSelection(post, navigate, {
      oauthQuery: SIGNED,
      workspaceId: "w",
      projectIds: "all_current",
    });
    expect(post).toHaveBeenCalledWith("/mcp-connect/selection", {
      oauthQuery: SIGNED,
      workspaceId: "w",
      projectIds: "all_current",
    });
    expect(navigate).toHaveBeenCalledWith(`/connect?${SIGNED}`);
  });

  it("deny calls consent with accept false and follows the redirect", async () => {
    const post = vi.fn().mockResolvedValue({
      redirect: "https://app.example/cb?error=access_denied&state=s1",
    });
    const navigate = vi.fn();
    await submitConsent(post, navigate, {
      oauthQuery: SIGNED,
      accept: false,
      scopes: ["openid", "orbit:read"],
    });
    expect(post).toHaveBeenCalledWith("/mcp-connect/consent", {
      oauthQuery: SIGNED,
      accept: false,
      scopes: [],
    });
    expect(navigate).toHaveBeenCalledWith(
      "https://app.example/cb?error=access_denied&state=s1",
    );
  });

  it("accept sends the ticked scopes in the requested order and never claims", async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ redirect: "https://app.example/cb?code=c" });
    const navigate = vi.fn();
    const requested = [
      "openid",
      "email",
      "orbit:read",
      "orbit:propose",
      "offline_access",
    ];
    await submitConsent(post, navigate, {
      oauthQuery: SIGNED,
      accept: true,
      scopes: acceptedScopes(requested, true),
    });
    expect(post.mock.calls[0]![1]).toEqual({
      oauthQuery: SIGNED,
      accept: true,
      scopes: requested,
    });
    expect(Object.keys(post.mock.calls[0]![1])).not.toContain("claims");
    expect(acceptedScopes(requested, false)).toEqual([
      "openid",
      "email",
      "orbit:read",
      "offline_access",
    ]);
    // orbit:read is mandatory even if a caller forgets it.
    expect(acceptedScopes(["orbit:propose"], true)).toEqual(["orbit:propose"]);
  });

  it("refuses to navigate when the answer carries no usable redirect", async () => {
    const post = vi.fn().mockResolvedValue({ redirect: "javascript:alert(1)" });
    const navigate = vi.fn();
    await expect(
      submitConsent(post, navigate, {
        oauthQuery: SIGNED,
        accept: true,
        scopes: ["orbit:read"],
      }),
    ).rejects.toThrow("OAUTH_NO_REDIRECT");
    expect(navigate).not.toHaveBeenCalled();
  });
});

const client = {
  id: "https://app.example/client.json",
  name: "Synthetic MCP Client",
  uri: "https://app.example",
};

function consent(
  props: Partial<Parameters<typeof ConsentStep>[0]> = {},
  locale: Locale = "en",
) {
  return renderToStaticMarkup(
    <ConsentStep
      t={t(locale)}
      client={client}
      scopes={[
        "openid",
        "email",
        "profile",
        "offline_access",
        "orbit:read",
        "orbit:propose",
      ]}
      workspace={{ name: "Synthetic org", role: "owner" }}
      projects={[{ id: "p1", name: "Project A" }]}
      allCurrent={false}
      propose
      onPropose={() => {}}
      onAccept={() => {}}
      onDeny={() => {}}
      pending={false}
      error={null}
      {...props}
    />,
  );
}

describe("consent step", () => {
  it("shows client name, its client_id host, the chosen workspace and projects, and every requested scope; orbit:read cannot be unticked", () => {
    const html = consent();
    expect(html).toContain("Synthetic MCP Client");
    expect(html).toContain("app.example");
    expect(html).toContain("Synthetic org");
    expect(html).toContain("Project A");
    for (const scope of [
      "openid",
      "email",
      "profile",
      "offline_access",
      "orbit:read",
      "orbit:propose",
    ])
      expect(html).toContain(scope);
    const input = (scope: string) =>
      html.match(new RegExp(`<input[^>]*value="${scope}"[^>]*>`))?.[0];
    const read = input("orbit:read")!;
    expect(read).toContain("checked");
    expect(read).toContain("disabled");
    const propose = input("orbit:propose")!;
    expect(propose).toContain("checked");
    expect(propose).not.toContain("disabled");
    // The informational scopes are not choices.
    expect(input("openid")).toBeUndefined();
  });

  it("offers the finance scopes as explicit choices that start unchecked, with their labels", () => {
    for (const locale of ["en", "de"] as const) {
      const html = consent(
        {
          scopes: ["orbit:read", "orbit:finance.read", "orbit:finance.extract"],
        },
        locale,
      );
      for (const scope of ["orbit:finance.read", "orbit:finance.extract"]) {
        const input = html.match(
          new RegExp(`<input[^>]*value="${scope}"[^>]*>`),
        )?.[0];
        expect(input).toBeDefined();
        expect(input).not.toContain("checked");
        expect(input).not.toContain("disabled");
      }
      expect(html).toContain(labels[locale].connectScopeFinanceRead);
      expect(html).toContain(labels[locale].connectScopeFinanceExtract);
    }
    const ticked = consent({
      scopes: ["orbit:read", "orbit:finance.read"],
      extraScopes: ["orbit:finance.read"],
    });
    expect(
      ticked.match(/<input[^>]*value="orbit:finance.read"[^>]*>/)?.[0],
    ).toContain("checked");
  });

  it("names all current projects when the selection covers them", () => {
    const html = consent({ allCurrent: true, projects: [] });
    expect(html).toContain("All current projects");
  });

  it("offers Allow and Deny and shows an error", () => {
    const html = consent({ error: "Something failed" });
    expect(html).toContain("Allow");
    expect(html).toContain("Deny");
    expect(html).toContain("Something failed");
    expect(consent({}, "de")).toContain("Erlauben");
  });

  it("escapes a hostile client name", () => {
    const html = consent({
      client: { ...client, name: '<img src=x onerror="alert(1)">' },
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("selection step", () => {
  const workspaces = [
    {
      id: "w1",
      name: "Org one",
      role: "owner",
      projects: [
        { id: "p1", name: "Project A" },
        { id: "p2", name: "Project B" },
      ],
    },
    { id: "w2", name: "Empty org", role: "viewer", projects: [] },
  ];
  const render = (props: Partial<Parameters<typeof SelectStep>[0]> = {}) =>
    renderToStaticMarkup(
      <SelectStep
        t={t("en")}
        client={client}
        workspaces={workspaces}
        workspaceId="w1"
        onWorkspace={() => {}}
        allProjects={false}
        onAllProjects={() => {}}
        projectIds={new Set(["p1"])}
        onToggleProject={() => {}}
        onContinue={() => {}}
        pending={false}
        error={null}
        {...props}
      />,
    );

  it("lists the workspaces and the projects of the chosen one", () => {
    const html = render();
    expect(html).toContain("Org one");
    expect(html).toContain("Empty org");
    expect(html).toContain("Project A");
    expect(html).toContain("Project B");
    expect(html).toContain("Synthetic MCP Client");
  });

  it("cannot continue without a project", () => {
    expect(render({ projectIds: new Set() })).toMatch(
      /<button[^>]*disabled[^>]*>\s*Continue/,
    );
    expect(render({ workspaceId: "w2" })).toContain("no project");
  });
});

describe("problems", () => {
  const html = (code: string, locale: Locale = "en") =>
    renderToStaticMarkup(<ConnectProblem t={t(locale)} code={code} />);

  it("NO_PROJECTS and OAUTH_REQUEST_EXPIRED render their messages", () => {
    expect(html("NO_PROJECTS")).toContain(labels.en.connectNoProjects);
    expect(html("OAUTH_REQUEST_EXPIRED")).toContain(labels.en.connectExpired);
    expect(html("OAUTH_REQUEST_INVALID")).toContain(labels.en.connectInvalid);
    expect(html("OAUTH_REQUEST_EXPIRED", "de")).toContain(
      labels.de.connectExpired,
    );
    expect(labels.en.connectExpired).not.toBe(labels.en.connectInvalid);
  });

  it("falls back to a generic message that shows the code as text", () => {
    const out = html("SOMETHING_ELSE");
    expect(out).toContain(labels.en.connectFailed);
    expect(out).toContain("SOMETHING_ELSE");
  });
});

describe("error page", () => {
  const page = (search: string) =>
    renderToStaticMarkup(<ConnectErrorPage t={t("en")} search={search} />);

  it("shows a generic message and the error code as plain text", () => {
    const out = page("?error=invalid_redirect&error_description=ignored");
    expect(out).toContain(labels.en.connectErrorTitle);
    expect(out).toContain("invalid_redirect");
    expect(out).not.toContain("ignored");
  });

  it("never renders markup from the query", () => {
    const out = page(
      `?error=${encodeURIComponent("<script>alert(1)</script>")}`,
    );
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
  });

  it("copes with no error code", () => {
    expect(page("")).toContain(labels.en.connectErrorTitle);
  });
});
