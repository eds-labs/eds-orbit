import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { codeOf, DataDeletionStatus } from "./data-deletion";

// The public status page of a Meta data-deletion request (ADR 0020): Meta
// links people to /data-deletion?code=… after Orbit disconnected them.

const CODE = "0".repeat(26) + "a".repeat(16);

describe("data-deletion status page", () => {
  it("reads only a well-formed confirmation code from the address", () => {
    expect(codeOf(`?code=${CODE}`)).toBe(CODE);
    expect(codeOf("?code=abc")).toBeNull();
    expect(codeOf(`?code=${CODE.toUpperCase()}`)).toBeNull();
    expect(codeOf("")).toBeNull();
  });

  it("says what a completed request removed and what stays", () => {
    const html = renderToStaticMarkup(
      <DataDeletionStatus locale="en" code={CODE} state={{ kind: "done", requestedAt: "2026-11-03T10:00:00.000Z" }} />,
    );
    expect(html).toContain("Completed");
    expect(html).toContain(CODE);
    expect(html).toContain("November 3, 2026");
    expect(html).toContain("deleted their access tokens");
    expect(html).toContain("stay on Facebook and Instagram");
    const de = renderToStaticMarkup(
      <DataDeletionStatus locale="de" code={CODE} state={{ kind: "done", requestedAt: "2026-11-03T10:00:00.000Z" }} />,
    );
    expect(de).toContain("Erledigt");
    expect(de).toContain("3. November 2026");
  });

  it("does not confirm an unknown code and offers a retry after an outage", () => {
    const unknown = renderToStaticMarkup(<DataDeletionStatus locale="en" code={CODE} state={{ kind: "unknown" }} />);
    expect(unknown).toContain("does not know this confirmation code");
    expect(unknown).not.toContain("Completed");
    expect(renderToStaticMarkup(<DataDeletionStatus locale="en" code={null} state={{ kind: "unknown" }} />)).toContain(
      "does not know this confirmation code",
    );
    expect(renderToStaticMarkup(<DataDeletionStatus locale="en" code={CODE} state={{ kind: "error" }} />)).toContain(
      "could not be loaded",
    );
  });
});
