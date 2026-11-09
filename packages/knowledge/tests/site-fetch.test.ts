import { describe, expect, it, vi } from "vitest";
import {
  KnowledgeError,
  RedirectError,
  fetchApprovedDocument,
  fetchDiscoveryDocument,
  type FetchFn,
} from "../src/index.ts";

const origin = "https://docs.example.com";
const policy = {
  allowedOrigins: [origin],
  allowedPaths: ["/familyplan-hilfe"],
};
const page = (url: string) => ({
  bytes: Buffer.from("<html>ok</html>"),
  mimeType: "text/html",
  url,
  etag: null,
});
const robots = (url: string, text: string) => ({
  bytes: Buffer.from(text),
  mimeType: "text/plain",
  url,
  etag: null,
});
const redirect = (location: string | null) => new RedirectError(location);

describe("site fetching", () => {
  it("follows a same-origin robots redirect", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url === `${origin}/robots.txt`)
        throw redirect("/familyplan-hilfe/robots.txt");
      if (url === `${origin}/familyplan-hilfe/robots.txt`)
        return robots(url, "User-agent: *\nAllow: /\n");
      return page(url);
    }) as unknown as FetchFn;
    const result = await fetchApprovedDocument(
      `${origin}/familyplan-hilfe/start`,
      policy,
      fetchFn,
    );
    expect(result.url).toBe(`${origin}/familyplan-hilfe/start`);
    const calls = vi.mocked(fetchFn).mock.calls;
    expect(calls[1]![1].allowedPaths).toEqual(["/familyplan-hilfe/robots.txt"]);
  });

  it.each([
    ["another origin", "https://evil.example.net/robots.txt"],
    ["a path not ending in /robots.txt", "/familyplan-hilfe/other.txt"],
    ["a missing location", null],
  ])("denies a robots redirect to %s", async (_n, location) => {
    const fetchFn = (async (url: string) => {
      if (url.endsWith("robots.txt") && url === `${origin}/robots.txt`)
        throw redirect(location);
      return page(url);
    }) as unknown as FetchFn;
    await expect(
      fetchApprovedDocument(
        `${origin}/familyplan-hilfe/start`,
        policy,
        fetchFn,
      ),
    ).rejects.toMatchObject({ code: "REDIRECT_NOT_ALLOWED" });
  });

  it("denies a robots redirect after more than 3 redirects", async () => {
    let n = 0;
    const fetchFn = (async (url: string) => {
      if (url.endsWith("/robots.txt")) throw redirect(`/a${++n}/robots.txt`);
      return page(url);
    }) as unknown as FetchFn;
    await expect(
      fetchApprovedDocument(
        `${origin}/familyplan-hilfe/start`,
        policy,
        fetchFn,
      ),
    ).rejects.toMatchObject({ code: "REDIRECT_NOT_ALLOWED" });
    expect(n).toBe(4);
  });

  it("applies a disallowing robots file after the redirect", async () => {
    const fetchFn = (async (url: string) => {
      if (url === `${origin}/robots.txt`)
        throw redirect("/familyplan-hilfe/robots.txt");
      if (url.endsWith("/robots.txt"))
        return robots(url, "User-agent: *\nDisallow: /familyplan-hilfe\n");
      return page(url);
    }) as unknown as FetchFn;
    await expect(
      fetchApprovedDocument(
        `${origin}/familyplan-hilfe/start`,
        policy,
        fetchFn,
      ),
    ).rejects.toMatchObject({ code: "ROBOTS_DISALLOWED" });
  });

  it("still refuses a redirect of the page itself", async () => {
    const fetchFn = (async (url: string) => {
      if (url.endsWith("/robots.txt"))
        throw new KnowledgeError("SOURCE_NOT_FOUND");
      throw redirect("/familyplan-hilfe/other");
    }) as unknown as FetchFn;
    await expect(
      fetchApprovedDocument(
        `${origin}/familyplan-hilfe/start`,
        policy,
        fetchFn,
      ),
    ).rejects.toMatchObject({ code: "REDIRECT_NOT_ALLOWED" });
  });

  it("keeps denying on an unknown robots failure", async () => {
    const fetchFn = (async (url: string) => {
      if (url.endsWith("/robots.txt"))
        throw new KnowledgeError("SOURCE_FETCH_FAILED");
      return page(url);
    }) as unknown as FetchFn;
    await expect(
      fetchApprovedDocument(
        `${origin}/familyplan-hilfe/start`,
        policy,
        fetchFn,
      ),
    ).rejects.toMatchObject({ code: "SOURCE_FETCH_FAILED" });
  });

  it("only discovery accepts XML", async () => {
    const fetchFn = vi.fn(async (url: string) =>
      url.endsWith("/robots.txt") ? robots(url, "") : page(url),
    ) as unknown as FetchFn;
    await fetchApprovedDocument(
      `${origin}/familyplan-hilfe/a`,
      policy,
      fetchFn,
    );
    await fetchDiscoveryDocument(
      `${origin}/familyplan-hilfe/sitemap.xml`,
      policy,
      fetchFn,
    );
    const calls = vi.mocked(fetchFn).mock.calls;
    const pageCall = calls.find((c) => c[0].endsWith("/a"))!;
    const xmlCall = calls.find((c) => c[0].endsWith("sitemap.xml"))!;
    expect(pageCall[1].discovery).toBeUndefined();
    expect(xmlCall[1].discovery).toBe(true);
    const robotsCalls = calls.filter((c) => c[0].endsWith("/robots.txt"));
    expect(robotsCalls.every((c) => c[1].discovery === undefined)).toBe(true);
  });
});
