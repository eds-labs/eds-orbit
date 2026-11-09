import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WebmailStatusView } from "./admin-webmail";

describe("webmail status", () => {
  it("shows the three states", () => {
    const html = renderToStaticMarkup(
      <WebmailStatusView
        status={{ enabled: true, originConfigured: true, bridge: "ok" }}
        locale="en"
      />,
    );
    expect(html).toContain("Enabled");
    expect(html).toContain("Origin configured");
    expect(html).toContain("reachable");
  });

  it("makes an unreachable bridge stand out, in German too", () => {
    const html = renderToStaticMarkup(
      <WebmailStatusView
        status={{ enabled: true, originConfigured: false, bridge: "unreachable" }}
        locale="de"
      />,
    );
    expect(html).toContain("nicht erreichbar");
    expect(html).toContain("badge-danger");
  });

  it("does not present a switched-off installation as a fault", () => {
    const html = renderToStaticMarkup(
      <WebmailStatusView
        status={{ enabled: false, originConfigured: false, bridge: "off" }}
        locale="en"
      />,
    );
    expect(html).not.toContain("badge-danger");
  });
});
