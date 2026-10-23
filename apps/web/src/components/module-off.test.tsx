import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { labels, type Text } from "@/lib/i18n";
import { ModuleOff } from "./orbit";

describe("module off notice", () => {
  const t: Text = (key) => labels.en[key];

  it("explains a missing module access instead of a turned-off module", () => {
    const html = renderToStaticMarkup(
      <ModuleOff t={t} homeHref="/p/p1" noAccess />,
    );
    expect(html).toContain("No access");
    expect(html).not.toContain("Module turned off");
  });

  it("keeps the turned-off text otherwise", () => {
    const html = renderToStaticMarkup(<ModuleOff t={t} homeHref="/p/p1" />);
    expect(html).toContain("Module turned off");
  });
});
