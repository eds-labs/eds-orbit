import { describe, expect, it } from "vitest";
import { webRegistry } from "@/modules/registry";
import * as management from "@/components/management";

// Settings center row 5.4: the old settings page shells are gone. The route
// table still knows their addresses (the redirect resolves them), but no page
// stands behind them.
describe("old settings page shells", () => {
  it("keeps the project routes settings and connectors without a page", () => {
    for (const key of ["settings", "connectors"]) {
      const route = webRegistry.platform.find((r) => r.key === key);
      expect(route, key).toBeDefined();
      expect(route?.component, key).toBeUndefined();
      expect(route?.legacyPaths?.length, key).toBeGreaterThan(0);
    }
  });

  it("keeps the standalone account routes without a page", () => {
    for (const key of ["account", "account-assistant"]) {
      const route = webRegistry.standalone!.find((r) => r.key === key);
      expect(route, key).toBeDefined();
      expect(route?.component, key).toBeUndefined();
    }
    expect(
      webRegistry.standalone!.find((r) => r.key === "account-confirm-email")
        ?.component,
    ).toBeDefined();
  });

  it("no longer exports the project settings page", () => {
    expect("ProjectSettings" in management).toBe(false);
  });
});
