import { describe, it, expect, vi } from "vitest";
import { createMatomoClient } from "./matomo.ts";
describe("Matomo page report transport", () => {
  it("requests flat URL rows through the bounded authenticated POST", async () => {
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("flat")).toBe("1");
      expect(body.get("filter_limit")).toBe("1000");
      expect(body.get("format_metrics")).toBe("0");
      expect(String(_url)).not.toContain("token_auth");
      return new Response(
        JSON.stringify([{ label: "https://example.invalid/page", nb_hits: 2 }]),
        { headers: { "content-type": "application/json" } },
      );
    });
    const result = await createMatomoClient({
      baseUrl: "https://analytics.example.invalid",
      token: "synthetic-matomo-test-token",
      allowedSiteIds: [17],
      fetch,
    }).report({
      siteId: 17,
      method: "Actions.getPageUrls",
      period: "day",
      date: "2026-09-16",
      siteTimezone: "Europe/Berlin",
    });
    expect(result.complete).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
