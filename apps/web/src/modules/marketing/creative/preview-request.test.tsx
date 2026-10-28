import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/components/workspace-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/workspace-context")>()),
  useWorkspace: () => ({ project: { id: "p1" } }),
}));
import { creativePreviewRenderer } from "./preview-request";
const View = creativePreviewRenderer.component;

const item = (operation: Record<string, unknown>) => ({
  actionType: "marketing.mcp.marketing_creative_preview_create",
  costCeilingMicros: 50_000,
  summary: { operation },
});

describe("Creative preview decision card", () => {
  it("shows the exact post text, image copy and the art prompt that goes to the provider", () => {
    const html = renderToStaticMarkup(
      <View
        de
        pending={false}
        decide={() => {}}
        item={item({
          channel: "instagram",
          template: "lifestyle",
          postText: "Synthetic <b>post</b> text",
          copy: { headline: "Warm evenings", cta: "Shop now" },
          art: "generate",
          maxBudgetMicros: 1_000_000,
          approvalContext: { artPrompt: "A reading lamp over a wool throw" },
        })}
      />,
    );
    expect(html).toContain("Interne Creative-Vorschau erstellen");
    expect(html).toContain("Synthetic &lt;b&gt;post&lt;/b&gt; text");
    expect(html).toContain("Warm evenings");
    expect(html).toContain("Neues KI-Bild (kostenpflichtig)");
    expect(html).toContain("A reading lamp over a wool throw");
    // It says what the approval does not do.
    expect(html).toContain("keine Veröffentlichung");
    expect(html).toContain("eine bestandene technische Prüfung ersetzt sie nicht");
  });
  it("shows a chosen library image directly", () => {
    const html = renderToStaticMarkup(
      <View
        de={false}
        pending={false}
        decide={() => {}}
        item={item({
          postText: "Synthetic text",
          art: "asset",
          artAssetId: "asset-1",
          maxBudgetMicros: 0,
        })}
      />,
    );
    expect(html).toContain("/api/projects/p1/assets/asset-1/content");
    expect(html).toContain("Approved image from the library");
  });
  it("leaves requests without the operation to the generic view", () => {
    expect(creativePreviewRenderer.accepts({ summary: {} })).toBe(false);
  });
});
