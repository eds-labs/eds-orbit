import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AdsDataDeletionStatus, codeOf } from "./data-deletion";

// The public status page of a Meta data-deletion request for the ads app
// (ADR 0025): Meta links people to /data-deletion/ads?code=… after Orbit
// unlinked their ad accounts.

const CODE = "0".repeat(26) + "a".repeat(16);
const NAMES = /(^|[-_])(ad|ads|advert|banner|sponsor)([-_]|$)/i;

describe("ads data-deletion status page", () => {
  it("reads only a well-formed confirmation code from the address", () => {
    expect(codeOf(`?code=${CODE}`)).toBe(CODE);
    expect(codeOf("?code=abc")).toBeNull();
    expect(codeOf(`?code=${CODE.toUpperCase()}`)).toBeNull();
    expect(codeOf("")).toBeNull();
  });

  it("says what a completed request removed and what stays, in both languages", () => {
    const state = { kind: "done", requestedAt: "2026-11-03T10:00:00.000Z" } as const;
    const en = renderToStaticMarkup(<AdsDataDeletionStatus locale="en" code={CODE} state={state} />);
    expect(en).toContain("Completed");
    expect(en).toContain(CODE);
    expect(en).toContain("November 3, 2026");
    expect(en).toContain("deleted the access tokens");
    expect(en).toContain("not touched");
    expect(en).toContain("stay with the project");
    const de = renderToStaticMarkup(<AdsDataDeletionStatus locale="de" code={CODE} state={state} />);
    expect(de).toContain("Erledigt");
    expect(de).toContain("3. November 2026");
    expect(de).toContain("Zugriffstoken");
    expect(de).toContain("nicht angetastet");
    for (const html of [en, de])
      for (const match of html.matchAll(/(?:class|id)="([^"]*)"/g))
        for (const part of match[1]!.split(/\s+/)) expect(part).not.toMatch(NAMES);
  });

  it("does not confirm an unknown code and shows an error after an outage", () => {
    const unknown = renderToStaticMarkup(<AdsDataDeletionStatus locale="en" code={CODE} state={{ kind: "unknown" }} />);
    expect(unknown).toContain("does not know this confirmation code");
    expect(unknown).not.toContain("Completed");
    expect(renderToStaticMarkup(<AdsDataDeletionStatus locale="de" code={null} state={{ kind: "unknown" }} />)).toContain(
      "kennt diesen Bestätigungscode nicht",
    );
    expect(renderToStaticMarkup(<AdsDataDeletionStatus locale="en" code={CODE} state={{ kind: "error" }} />)).toContain(
      "could not be loaded",
    );
  });
});
