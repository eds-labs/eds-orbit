import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PageHead, PageHeadLevel } from "./collection";

describe("PageHead", () => {
  it("is the page's h1 by default", () => {
    expect(renderToStaticMarkup(<PageHead title="T" description="D" />)).toContain(
      "<h1>T</h1>",
    );
  });

  it("takes the level of the surrounding page", () => {
    const html = renderToStaticMarkup(
      <PageHeadLevel.Provider value="h2">
        <PageHead title="T" description="D" />
      </PageHeadLevel.Provider>,
    );
    expect(html).toContain("<h2>T</h2>");
    expect(html).not.toContain("<h1>");
  });

  it("keeps an explicit level", () => {
    const html = renderToStaticMarkup(
      <PageHeadLevel.Provider value="h2">
        <PageHead as="h1" title="T" description="D" />
      </PageHeadLevel.Provider>,
    );
    expect(html).toContain("<h1>T</h1>");
  });
});
