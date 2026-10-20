import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { McpReplySetting, inboxBody } from "./settings";
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
  it("is inbox-specific and preserves its opt-in alongside existing inbox rules", () => {
    const html = renderToStaticMarkup(
      <McpReplySetting
        enabled={false}
        disabled={false}
        onChange={() => {}}
        t={supportText("de")}
      />,
    );
    expect(html).toContain("nur für Tickets in diesem Posteingang");
    const rules = {
      autoAck: false,
      autoClose: true,
      autoCloseDays: 12,
      reopenOnReply: false,
      sla: false,
      mcpOwnerRepliesWithoutApproval: true,
    };
    expect(
      inboxBody({
        name: "Support",
        email: true,
        widget: false,
        emailConnectionId: "mailbox",
        origins: "",
        aiMode: "off",
        language: "de",
        rules,
      }).rules,
    ).toEqual(rules);
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
