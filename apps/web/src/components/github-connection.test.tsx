import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Entity } from "@/lib/api";
import {
  GithubConnectorSummary,
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

describe("GithubConnectorSummary (R83)", () => {
  const connector = {
    id: "0f6c3b1e-2a4d-4c8e-9b7a-5d1e2f3a4b5c",
    version: 3,
    data: {
      provider: "github",
      owner: "eds-labs",
      repo: "uliquid-site",
      baseBranch: "main",
      postsPath: "content/blog/posts",
      siteUrl: "https://uliquid.vip",
      tokenExpiresAt: "2027-01-31",
      status: "write_verified",
    },
  } as unknown as Entity;

  it("shows the connector id to copy and the repository", () => {
    const html = renderToStaticMarkup(
      <GithubConnectorSummary connector={connector} de />,
    );
    expect(html).toContain("Connector-ID");
    expect(html).toContain("0f6c3b1e-2a4d-4c8e-9b7a-5d1e2f3a4b5c");
    expect(html).toContain("ID kopieren");
    expect(html).toContain("eds-labs/uliquid-site");
  });
});
