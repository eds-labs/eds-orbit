import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  exposedToAgent,
  exposedToAssistant,
  exposedToMcp,
  responsesTool,
  type ToolContext,
} from "../../platform/agents/tools/registry.ts";
import { projectBoundParameters } from "../../platform/agents/project-calls.ts";
import {
  assertProviderAllowedForData,
  strictestDataClass,
} from "../../platform/ai/data-class.ts";
import { MCP_SCOPES } from "../../platform/mcp-auth/plugins.ts";
import { MCP_RESOURCE_SCOPES } from "../../platform/mcp/server.ts";
import {
  lacksModuleConsent,
  SEO_READ_SCOPE,
} from "../../platform/mcp/scopes.ts";
import { requiredScope } from "../../platform/mcp/visibility.ts";
import { requireSeoTaskConsent } from "../../platform/tasks/delegation.ts";
import { SEO_READ } from "./permissions.ts";
import { listSeoWebsites, searchPerformance } from "./service.ts";
import { seoTools } from "./tools.ts";

vi.mock("./service.ts", () => ({
  listSeoWebsites: vi.fn(),
  searchPerformance: vi.fn(),
}));
vi.mock("../../platform/tenancy/scope.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../platform/tenancy/scope.ts")>()),
  userScoped: vi.fn((_, run) => run({})),
}));

const [listWebsites, performance] = seoTools;
const websiteId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const connectionId = "00000000-0000-4000-8000-000000000003";
const context: ToolContext = {
  scope: {
    workspaceId: "synthetic-organization",
    projectId,
    userId: "synthetic-viewer",
    role: "viewer",
  },
  runId: "synthetic-run",
  conversationId: "synthetic-conversation",
  callIndex: 1,
};
const query = {
  provider: "google-search-console",
  startDate: "2026-11-01",
  endDate: "2026-11-15",
};

describe("SEO tool contracts", () => {
  it("exposes strict read capabilities in the Assistant, configured agents and MCP", () => {
    expect(seoTools.map((t) => t.name)).toEqual([
      "seo_websites_list",
      "seo_search_performance",
    ]);
    for (const tool of seoTools) {
      expect(exposedToAssistant(tool)).toBe(true);
      expect(exposedToAgent(tool)).toBe(true);
      expect(exposedToMcp(tool)).toBe(true);
      expect(tool.risk).toBe("R0_read");
      expect(tool.permission).toBe(SEO_READ);
      expect(requiredScope(tool)).toBe("orbit:read");
      expect(tool.mcpScopes).toEqual([SEO_READ_SCOPE]);
      expect(tool.outputSchema).toBeInstanceOf(z.ZodObject);
      expect(tool.parameters.safeParse({ projectId }).success).toBe(false);
      const mcpInput = projectBoundParameters(tool, { optional: true });
      expect(mcpInput.shape.projectId.safeParse(undefined).success).toBe(false);
      expect(mcpInput.shape.projectId.safeParse(projectId).success).toBe(true);
      expect(() => responsesTool(tool)).not.toThrow();
    }
    expect(performance.openWorld).toBe(true);
    const dataClass = strictestDataClass(seoTools);
    expect(dataClass).toBe("customer_personal");
    expect(() => assertProviderAllowedForData("anthropic", dataClass)).toThrow(
      "AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA",
    );
    expect(() =>
      assertProviderAllowedForData("openai", dataClass),
    ).not.toThrow();
  });

  it("advertises the explicit read permission and requires it for delegated SEO work", () => {
    expect(MCP_SCOPES).toContain(SEO_READ_SCOPE);
    expect(MCP_RESOURCE_SCOPES).toContain(SEO_READ_SCOPE);
    expect(lacksModuleConsent(["seo"], new Set(["orbit:read"]))).toBe(true);
    expect(lacksModuleConsent(["seo"], new Set([SEO_READ_SCOPE]))).toBe(false);
    for (const scope of ["orbit:read", SEO_READ_SCOPE]) {
      expect(() => requireSeoTaskConsent(["seo"], new Set([scope]))).toThrow(
        "MCP_SEO_CONSENT_REQUIRED",
      );
    }
    expect(() =>
      requireSeoTaskConsent(["seo"], new Set(["orbit:read", SEO_READ_SCOPE])),
    ).not.toThrow();
  });

  it("validates bounds before invoking the native service", async () => {
    vi.mocked(searchPerformance).mockClear();
    for (const invalid of [
      { websiteId: "invalid" },
      { startDate: "2026-02-30" },
      { endDate: "2026-07-01" },
      { startDate: "2026-04-01" },
      { dimension: "searchAppearance" },
      { limit: 100_000 },
      { propertyId: "a-property-not-attached-to-the-project" },
      { workspaceId: "other-organization" },
    ]) {
      await expect(
        performance.execute(context, { websiteId, ...query, ...invalid }),
      ).rejects.toThrow(z.ZodError);
    }
    expect(searchPerformance).not.toHaveBeenCalled();
  });

  it("uses the current project and removes provider connection IDs from the website view", async () => {
    vi.mocked(listSeoWebsites).mockResolvedValueOnce([
      {
        id: websiteId,
        name: "Example website",
        url: "https://example.invalid/",
        properties: [
          {
            provider: query.provider,
            propertyId: "sc-domain:example.invalid",
            connectionId,
          },
        ],
      },
    ]);
    const result = await listWebsites.execute(context, {});
    expect(listSeoWebsites).toHaveBeenCalledWith({}, context.scope);
    expect(result).toEqual({
      output: {
        websites: [
          {
            id: websiteId,
            name: "Example website",
            url: "https://example.invalid/",
            properties: [
              {
                provider: query.provider,
                propertyId: "sc-domain:example.invalid",
              },
            ],
          },
        ],
      },
      cards: [],
    });
  });

  it("passes a bounded query to the service and returns structured, cleaned provider rows", async () => {
    const metrics = { clicks: 5, impressions: 40, ctr: 0.125, position: 2.3 };
    vi.mocked(searchPerformance).mockResolvedValueOnce({
      ...query,
      websiteId,
      dimension: "query",
      rows: [{ ...metrics, keys: ["example\u0002 search\u202e"] }],
    });
    const result = await performance.execute(context, {
      websiteId,
      ...query,
      dimension: "query",
      limit: null,
    });
    expect(searchPerformance).toHaveBeenCalledWith(context.scope, websiteId, {
      ...query,
      dimension: "query",
      limit: 100,
    });
    expect(result).toEqual({
      output: {
        ...query,
        websiteId,
        dimension: "query",
        rows: [{ ...metrics, keys: ["example  search "] }],
      },
      cards: [],
    });
  });
});
