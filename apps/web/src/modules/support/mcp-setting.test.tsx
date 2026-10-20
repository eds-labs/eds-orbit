import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { McpReplySetting } from "./settings";
import { supportText } from "./labels";

describe("owner direct MCP replies setting", () => {
  it("describes the external send and preserves the current off/on state", () => {
    const render = (enabled: boolean) =>
      renderToStaticMarkup(
        <McpReplySetting
          enabled={enabled}
          disabled={false}
          onChange={() => {}}
          t={supportText("de")}
        />,
      );
    expect(render(false)).toContain("Standardmäßig aus");
    expect(render(false)).toContain("ohne weitere Orbit-Freigabe");
    expect(render(false)).not.toContain('checked=""');
    expect(render(true)).toContain('checked=""');
    expect(render(false)).toContain(
      'aria-describedby="support-mcp-replies-hint"',
    );
  });
  it("keeps the setting disabled for members who cannot administer Support", () => {
    const html = renderToStaticMarkup(
      <McpReplySetting
        enabled={true}
        disabled={true}
        onChange={() => {}}
        t={supportText("en")}
      />,
    );
    expect(html).toContain('<fieldset disabled="">');
    expect(html).toContain(
      "Other roles and other actions still require approval",
    );
  });
});
