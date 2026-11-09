import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { describe, expect, it } from "vitest";
import config from "../../../next.config";

type Rule = { source: string; headers: Array<{ key: string; value: string }> };

/** Next applies matching rules in order, so a later rule wins for its key. */
function resolve(rules: readonly Rule[], path: string) {
  const result: Record<string, string> = {};
  for (const rule of rules)
    if (getPathMatch(rule.source)(path) !== false)
      for (const { key, value } of rule.headers) result[key] = value;
  return result;
}

describe("response headers", async () => {
  const rules = (await config.headers!()) as Rule[];
  const WEBMAIL = "/p/project-1/webmail";

  it("opens the referrer policy on the webmail route only", () => {
    expect(resolve(rules, WEBMAIL)["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    for (const path of [
      "/",
      "/p/project-1",
      "/p/project-1/support/tickets",
      "/p/project-1/settings",
      "/p/project-1/webmailer",
      "/p/project-1/webmail/deeper",
      "/admin",
    ])
      expect(resolve(rules, path)["Referrer-Policy"]).toBe("same-origin");
  });

  it("depends on the webmail rule coming last", () => {
    const at = (source: string) => rules.findIndex((rule) => rule.source === source);
    expect(at("/p/:projectId/webmail")).toBeGreaterThan(at("/:path*"));
    expect(resolve([...rules].reverse(), WEBMAIL)["Referrer-Policy"]).toBe("same-origin");
  });

  it("keeps the other protections on the webmail route", () => {
    const headers = resolve(rules, WEBMAIL);
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });
});
