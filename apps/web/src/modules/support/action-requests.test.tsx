import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/components/workspace-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/workspace-context")>()),
  useWorkspace: () => ({ project: { id: "p1" } }),
}));
import {
  supportDecisionRenderer,
  supportTaxonomyRenderer,
} from "./action-requests";
const View = supportDecisionRenderer.component;

describe("Support decision card", () => {
  it("shows the exact reply, recipient and ticket link with escaped message text", () => {
    const html = renderToStaticMarkup(
      <View
        de
        pending={false}
        decide={() => {}}
        item={{
          actionType: "support.mcp.support_send_reply",
          costCeilingMicros: 0,
          summary: {
            operation: {
              ticketId: "ticket1",
              bodyText: "Synthetic <script>reply</script>",
              approvalContext: {
                ticketNumber: 5,
                recipient: "test@example.invalid",
              },
            },
          },
        }}
      />,
    );
    expect(html).toContain("Antwort an Kunden senden");
    expect(html).toContain("test@example.invalid");
    expect(html).toContain("/p/p1/support/tickets?ticket=ticket1");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Antwort senden");
  });
  it("retains the paid AI cost ceiling and locks decision controls while pending", () => {
    const html = renderToStaticMarkup(
      <View
        de
        pending={true}
        decide={() => {}}
        item={{
          actionType: "support.mcp.support_generate_reply",
          costCeilingMicros: 500000,
          summary: { operation: { ticketId: "t" } },
        }}
      />,
    );
    expect(html).toContain("Höchstkosten");
    expect(html).toContain("$0.50");
    expect(html).toContain('disabled=""');
  });
});

describe("Support taxonomy approval", () => {
  it("shows escaped before/after values and a settings link without a fabricated ticket", () => {
    const View = supportTaxonomyRenderer.component;
    const item = {
      actionType: "support.mcp.support_update_tag",
      summary: {
        operation: {
          approvalContext: {
            taxonomy: {
              kind: "tag",
              action: "update",
              key: "billing",
              before: {
                key: "billing",
                label: "Old",
                color: "gray",
              },
              after: {
                key: "billing",
                label: "Billing <script>unsafe</script>",
                color: "blue",
              },
            },
          },
        },
      },
    };
    const html = renderToStaticMarkup(
      <View de pending={true} decide={() => {}} item={item} />,
    );
    expect(html).toContain("Tag ändern");
    expect(html).toContain("Bisher");
    expect(html).toContain("Old");
    expect(html).toContain("Blau");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("/p/p1/settings?section=support");
    expect(html).not.toContain("ticket=");
    expect(html).toContain('disabled=""');
  });
  it("explains deletion usage protection and validates the renderer context", () => {
    const View = supportTaxonomyRenderer.component;
    const item = {
      summary: {
        operation: {
          approvalContext: {
            taxonomy: {
              kind: "category",
              action: "delete",
              key: "unused",
              before: {
                label: "Unused",
              },
              after: null,
            },
          },
        },
      },
    };
    expect(supportTaxonomyRenderer.accepts(item)).toBe(true);
    expect(
      supportTaxonomyRenderer.accepts({
        summary: { operation: { ticketId: "t" } },
      }),
    ).toBe(false);
    const html = renderToStaticMarkup(
      <View item={item} de={false} pending={false} decide={() => {}} />,
    );
    expect(html).toContain("Delete category");
    expect(html).toContain("only while the key is unused");
    expect(html).toContain("Absent");
  });
});
