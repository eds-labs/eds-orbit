import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  GithubVerifyResult,
  githubConnectorFields,
  githubConnectorPayload,
  githubCredentialFields,
  githubCredentialPayload,
} from "./github-connection";

describe("githubConnectorFields (R81)", () => {
  it("asks for repository, branch, posts path, site URL, token and its expiry", () => {
    const fields = githubConnectorFields(true);
    expect(fields.map((field) => field.name)).toEqual([
      "owner",
      "repo",
      "baseBranch",
      "postsPath",
      "siteUrl",
      "credential",
      "tokenExpiresAt",
    ]);
    const field = (name: string) => fields.find((f) => f.name === name)!;
    expect(field("credential").type).toBe("password");
    expect(field("tokenExpiresAt").type).toBe("date");
    expect(field("baseBranch").value).toBe("main");
    expect(field("postsPath").value).toBe("content/blog/posts");
    expect(field("siteUrl").type).toBe("url");
  });

  it("builds the connector action input with the profile", () => {
    expect(
      githubConnectorPayload({
        owner: " eds-labs ",
        repo: "site",
        baseBranch: "main",
        postsPath: "content/blog/posts",
        siteUrl: "https://uliquid.vip",
        credential: "github_pat_secret",
        tokenExpiresAt: "2027-10-01",
      }),
    ).toEqual({
      provider: "github",
      owner: "eds-labs",
      repo: "site",
      baseBranch: "main",
      postsPath: "content/blog/posts",
      siteUrl: "https://uliquid.vip",
      blogPathPrefix: "/blog/",
      profile: "uliquid-blog-json-v1",
      credential: "github_pat_secret",
      tokenExpiresAt: "2027-10-01",
    });
  });

  it("renews only the token and its expiry", () => {
    const fields = githubCredentialFields(false);
    expect(fields.map((field) => [field.name, field.type])).toEqual([
      ["credential", "password"],
      ["tokenExpiresAt", "date"],
    ]);
    expect(
      githubCredentialPayload({
        credential: "github_pat_new",
        tokenExpiresAt: "2027-11-01",
      }),
    ).toEqual({ credential: "github_pat_new", tokenExpiresAt: "2027-11-01" });
  });
});

describe("GithubVerifyResult", () => {
  it("shows the verified status", () => {
    const html = renderToStaticMarkup(
      <GithubVerifyResult
        de
        result={{ status: "write_verified", problems: [] }}
      />,
    );
    expect(html).toContain("Lesen und Schreiben geprüft");
  });

  it("lists the problems", () => {
    const html = renderToStaticMarkup(
      <GithubVerifyResult
        de={false}
        result={{
          status: "configured",
          problems: ["GITHUB_BASE_BRANCH_NOT_FOUND", "a.json: title missing"],
        }}
      />,
    );
    expect(html).toContain("Not verified");
    expect(html).toContain("GITHUB_BASE_BRANCH_NOT_FOUND");
    expect(html).toContain("a.json: title missing");
  });
});
