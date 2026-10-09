import { describe, expect, it } from "vitest";
import { bodyLinkProblems } from "./agent-review.ts";

const ALLOWED = ["https://example.invalid"];

describe("bodyLinkProblems", () => {
  it("passes a text without links or with only allowed ones", () => {
    expect(
      bodyLinkProblems("Beta access is open. Learn more.", ALLOWED),
    ).toEqual([]);
    expect(
      bodyLinkProblems("Details at https://example.invalid/beta.", ALLOWED),
    ).toEqual([]);
    expect(
      bodyLinkProblems("Details on example.invalid/beta.", ALLOWED),
    ).toEqual([]);
    // Numbers, versions and abbreviations are not hosts.
    expect(
      bodyLinkProblems("Version 2.5 is here, e.g. for 1.000 teams.", ALLOWED),
    ).toEqual([]);
  });

  it("blocks a written link with a scheme or www. outside the allowed origins", () => {
    expect(
      bodyLinkProblems(
        "Sign up at https://beta-signup.example/teams.",
        ALLOWED,
      ),
    ).toEqual(["LINK_NOT_ALLOWED"]);
    expect(
      bodyLinkProblems("Sign up at http://example.invalid/teams.", ALLOWED),
    ).toEqual(["LINK_NOT_ALLOWED"]);
    expect(
      bodyLinkProblems("See www.other-site.example today.", ALLOWED),
    ).toEqual(["LINK_NOT_ALLOWED"]);
  });

  it("marks a bare host outside the allowed origins as unverified", () => {
    expect(
      bodyLinkProblems("Sign up at beta-signup.example/teams today.", ALLOWED),
    ).toEqual(["LINK_UNVERIFIED"]);
    expect(bodyLinkProblems("Mail us at team@other.example.", ALLOWED)).toEqual(
      ["LINK_UNVERIFIED"],
    );
    // A false positive the owner then decides on.
    expect(bodyLinkProblems("Built with Node.js.", ALLOWED)).toEqual([
      "LINK_UNVERIFIED",
    ]);
  });

  it("reports both kinds when both occur", () => {
    expect(
      bodyLinkProblems(
        "See https://a.example and b-site.example for details.",
        ALLOWED,
      ),
    ).toEqual(["LINK_NOT_ALLOWED", "LINK_UNVERIFIED"]);
  });
});
