import { describe, expect, it } from "vitest";
import {
  REQUEST_MARKER,
  assertNoHits,
  githubExternalId,
  githubIssueText,
  issueOrbitUrl,
  parseGithubIssueUrl,
} from "../src/modules/issues/github-body.ts";
import type { shareableFields } from "../src/modules/issues/issues.ts";

type Fields = ReturnType<typeof shareableFields>;
const fields = (over: Partial<Fields> = {}): Fields => ({
  key: "ISS-7",
  title: "Checkout fails",
  summary: "The checkout page shows an error.",
  type: "bug",
  severity: "high",
  components: ["web", "api"],
  acceptanceCriteria: ["Checkout succeeds", "Error is logged"],
  ...over,
});
const input = { requestId: "req-1", orbitUrl: "https://orbit.example/p/p1/issues/list?issue=i1" };

describe("githubIssueText", () => {
  it("builds the exact layout", () => {
    const { title, body, hits } = githubIssueText(fields(), input);
    expect(title).toBe("[ISS-7] Checkout fails");
    expect(body).toBe(
      [
        "<!-- orbit-ref:req-1 -->",
        "Orbit-Issue: ISS-7",
        "",
        "**Type:** bug · **Severity:** high · **Components:** web, api",
        "",
        "The checkout page shows an error.",
        "",
        "### Acceptance criteria",
        "- Checkout succeeds",
        "- Error is logged",
        "",
        "[Open in Orbit](https://orbit.example/p/p1/issues/list?issue=i1)",
      ].join("\n"),
    );
    expect(hits).toEqual({});
    expect(REQUEST_MARKER("req-1")).toBe("<!-- orbit-ref:req-1 -->");
  });

  it("uses dashes and omits empty sections", () => {
    const { body } = githubIssueText(fields({ severity: null, components: [], acceptanceCriteria: [] }), input);
    expect(body).toContain("**Severity:** — · **Components:** —");
    expect(body).not.toContain("Acceptance criteria");
  });

  const canaries = [
    "kunde.weber@example.org",
    "+49 170 1234567",
    "DE89370400440532013000",
    "0x52908400098527886E0F7030069857D2E4169EE7",
    "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  ];
  for (const canary of canaries) {
    it(`reports a hit and refuses ${canary.slice(0, 6)}… in summary or criterion`, () => {
      for (const f of [fields({ summary: `see ${canary} here` }), fields({ acceptanceCriteria: [`use ${canary}`] })]) {
        const text = githubIssueText(f, input);
        expect(Object.keys(text.hits).length).toBeGreaterThan(0);
        expect(Object.values(text.hits).every((n) => n > 0)).toBe(true);
        let thrown: unknown;
        try {
          assertNoHits(text);
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toMatchObject({ code: "ISSUES_GITHUB_REDACTION_HIT", status: 409 });
        const dump = JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object));
        expect(dump).not.toContain(canary);
      }
    });
  }

  it("sums hits over title and body and passes clean text", () => {
    const dirty = githubIssueText(fields({ title: "mail a@b.org", summary: "also c@d.org" }), input);
    expect(dirty.hits.email).toBe(2);
    expect(() => assertNoHits(githubIssueText(fields(), input))).not.toThrow();
  });

  it("never flags the generated marker and Orbit link", () => {
    // Real ids whose digit runs look like phone numbers to the strict profile.
    const ids = {
      requestId: "9de95c51-0035-4851-9698-62dbfd4b6aec",
      orbitUrl: "https://orbit.example/p/07948255-011f-4b22-a3d8-1afb2ba02eef/issues/list?issue=96a36dd7-0651-4325-be58-e8b09b5c32f4",
    };
    expect(githubIssueText(fields(), ids).hits).toEqual({});
    expect(githubIssueText(fields({ summary: "call +49 170 1234567" }), ids).hits).toEqual({ phone: 1 });
  });

  it("title is truncated to 256 characters", () => {
    const { title } = githubIssueText(fields({ title: "x".repeat(400) }), input);
    expect(title).toHaveLength(256);
    expect(title.startsWith("[ISS-7] xxx")).toBe(true);
  });

  it("does not split a surrogate pair at the boundary", () => {
    const prefix = "[ISS-7] ";
    const { title } = githubIssueText(fields({ title: "x".repeat(256 - prefix.length - 1) + "😀tail" }), input);
    expect(title.length).toBeLessThanOrEqual(256);
    expect(title.endsWith("x")).toBe(true);
    expect(() => encodeURIComponent(title)).not.toThrow();
  });
});

describe("issueOrbitUrl", () => {
  it("builds an absolute link from APP_ORIGIN", () => {
    const url = issueOrbitUrl("p1", "i1");
    expect(url).toMatch(/^https?:\/\/.+\/p\/p1\/issues\/list\?issue=i1$/);
  });
});

describe("parseGithubIssueUrl", () => {
  it("accepts the exact shape", () => {
    expect(parseGithubIssueUrl("https://github.com/eds-labs/orbit/issues/12")).toEqual({ fullName: "eds-labs/orbit", number: 12 });
    expect(parseGithubIssueUrl("https://github.com/Eds_Labs/or.bit/issues/12#issuecomment-1")).toEqual({ fullName: "Eds_Labs/or.bit", number: 12 });
    expect(githubExternalId("eds-labs/orbit", 12)).toBe("eds-labs/orbit#12");
  });
  const bad = [
    "https://github.com/eds-labs/orbit/pull/12",
    "http://github.com/eds-labs/orbit/issues/12",
    "https://github.com.evil.example/eds-labs/orbit/issues/12",
    "https://gist.github.com/eds-labs/orbit/issues/12",
    "https://www.github.com/eds-labs/orbit/issues/12",
    "https://github.com/eds-labs/orbit/issues/",
    "https://github.com/eds-labs/orbit/issues",
    "https://github.com/eds-labs/orbit/issues/12/",
    "https://github.com/eds-labs/orbit/issues/12?x=1",
    "https://github.com/eds-labs/orbit/issues/12/extra",
    "https://x@github.com/eds-labs/orbit/issues/12",
    "https://x:y@github.com/eds-labs/orbit/issues/12",
    "https://github.com:443/eds-labs/orbit/issues/12",
    "https://github.com/eds-labs/orbit/issues/0",
    "https://github.com/eds-labs/orbit/issues/012",
    "https://github.com/eds-labs/orbit/issues/-3",
    "https://github.com/eds-labs/orbit/issues/1.5",
    "https://github.com/eds-labs/orbit/issues/2147483648",
    "https://github.com/../orbit/issues/12",
    "https://github.com/eds-labs/../issues/12",
    "https://github.com/./orbit/issues/12",
    "https://github.com/eds labs/orbit/issues/12",
    "",
  ];
  for (const url of bad)
    it(`refuses ${JSON.stringify(url)}`, () => {
      expect(() => parseGithubIssueUrl(url)).toThrowError(expect.objectContaining({ code: "ISSUES_GITHUB_URL_INVALID" }));
    });
  it("accepts the largest number", () => {
    expect(parseGithubIssueUrl("https://github.com/a/b/issues/2147483647").number).toBe(2147483647);
  });
});
