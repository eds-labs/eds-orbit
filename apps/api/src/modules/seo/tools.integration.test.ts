import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDatabase } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  executeCapability,
  resolveCapabilities,
} from "../../platform/agents/capabilities.ts";
import type { McpPrincipal } from "../../platform/mcp/principal.ts";
import { SEO_READ_SCOPE } from "../../platform/mcp/scopes.ts";
import {
  authorizeMcpCall,
  visibleMcpTools,
  visibleMcpToolsForDiscovery,
} from "../../platform/mcp/visibility.ts";
import { setMemberModuleRoles } from "../../platform/tenancy/module-roles.ts";
import { createIssuesProject } from "../../../tests/support/issues-project.ts";
import { seoTools } from "./tools.ts";

const argsForWebsite = (websiteId: string) => ({
  websiteId,
  provider: "google-search-console",
  startDate: "2026-11-01",
  endDate: "2026-11-02",
});

const names = ["seo_search_performance", "seo_websites_list"];
const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const selectedSeoTools = (tools: readonly { name: string }[]) =>
  tools
    .map((t) => t.name)
    .filter((name) => name.startsWith("seo_"))
    .sort();

function principal(
  scope: Scope,
  scopes: string[] = ["orbit:read", SEO_READ_SCOPE],
): McpPrincipal {
  return {
    workspaceId: scope.workspaceId,
    projectIds: [scope.projectId],
    userId: scope.userId,
    grantId: "synthetic-seo-grant",
    clientId: "https://example.invalid/mcp-client.json",
    scopes: new Set(scopes),
    modules: [],
  };
}

describe.skipIf(!enabled)(
  "SEO capabilities through project and MCP policies",
  () => {
    let project: Awaited<ReturnType<typeof createIssuesProject>>;
    let other: Awaited<ReturnType<typeof createIssuesProject>>;
    let foreignWebsiteId: string;

    beforeAll(async () => {
      vi.stubEnv("ORBIT_SEO", "true");
      vi.stubEnv("ORBIT_MODULES", "false");
      vi.stubEnv("ORBIT_MODULE_ROLES", "true");
      project = await createIssuesProject({
        name: "Synthetic SEO MCP",
        modules: ["seo"],
      });
      other = await createIssuesProject({
        name: "Other synthetic project",
        modules: [],
      });
      const website = await other.run((tx) =>
        tx.seoWebsite.create({
          data: {
            workspaceId: other.owner.workspaceId,
            projectId: other.owner.projectId,
            name: "Private website",
            url: "https://other.example.invalid/",
          },
          select: { id: true },
        }),
      );
      foreignWebsiteId = website.id;
    });

    afterAll(async () => {
      vi.unstubAllEnvs();
      await other?.cleanup();
      await project?.cleanup();
      await closeDatabase();
    });

    it("advertises schemas for consent and requires both scopes to list or run", async () => {
      const { viewer } = project;
      expect(
        selectedSeoTools(
          await visibleMcpTools(principal(viewer), viewer.projectId),
        ),
      ).toEqual(names);
      expect(
        selectedSeoTools(
          await visibleMcpToolsForDiscovery(
            principal(viewer, ["orbit:read"]),
            viewer.projectId,
          ),
        ),
      ).toEqual(names);
      for (const scope of ["orbit:read", SEO_READ_SCOPE]) {
        const limited = principal(viewer, [scope]);
        expect(
          selectedSeoTools(await visibleMcpTools(limited, viewer.projectId)),
        ).toEqual([]);
        await expect(
          authorizeMcpCall(limited, "seo_websites_list", viewer.projectId),
        ).rejects.toMatchObject({ code: "MCP_TOOL_NOT_ALLOWED" });
      }
      const restricted = { ...principal(viewer), modules: ["marketing"] };
      expect(
        selectedSeoTools(await visibleMcpTools(restricted, viewer.projectId)),
      ).toEqual([]);
    });

    it("uses the registered RLS service under the viewer's authorized project scope", async () => {
      const client = principal(project.viewer);
      const { tool, scope } = await authorizeMcpCall(
        client,
        "seo_websites_list",
        project.viewer.projectId,
      );
      expect(
        await executeCapability(
          tool,
          {
            scope,
            runId: "test",
            conversationId: "test",
            callIndex: 1,
            channel: {
              kind: "mcp",
              clientId: client.clientId,
              grantId: client.grantId,
              requestId: "test",
            },
          },
          {},
        ),
      ).toEqual({ output: { websites: [] }, cards: [] });
      await expect(
        authorizeMcpCall(client, "seo_websites_list", other.owner.projectId),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        authorizeMcpCall(
          {
            ...client,
            projectIds: [...client.projectIds, other.owner.projectId],
          },
          "seo_websites_list",
          other.owner.projectId,
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      const report = await authorizeMcpCall(
        client,
        "seo_search_performance",
        project.viewer.projectId,
      );
      await expect(
        executeCapability(
          report.tool,
          {
            scope: report.scope,
            runId: "test",
            conversationId: "test",
            callIndex: 1,
          },
          argsForWebsite(foreignWebsiteId),
        ),
      ).rejects.toMatchObject({ code: "SEO_WEBSITE_NOT_FOUND" });
    });

    it("limits both internal and external capability visibility to active authorized projects", async () => {
      const byAgent = (scope: Scope) =>
        resolveCapabilities(scope, {
          channel: "agent",
          enabled: new Set(["seo"]),
          features: ["seo"],
        });
      expect(selectedSeoTools(byAgent(project.viewer))).toEqual(names);
      expect(
        selectedSeoTools(
          byAgent({ ...project.viewer, moduleRoles: { seo: "none" } }),
        ),
      ).toEqual([]);
      const viewer = await project.member("viewer");
      await setMemberModuleRoles(project.owner, viewer.userId, {
        roles: { seo: "none" },
      });
      expect(
        selectedSeoTools(
          await visibleMcpTools(principal(viewer), viewer.projectId),
        ),
      ).toEqual([]);
      expect(
        selectedSeoTools(
          await visibleMcpTools(principal(other.owner), other.owner.projectId),
        ),
      ).toEqual([]);
      const query = argsForWebsite(randomUUID());
      const tool = seoTools.find((t) => t.name === "seo_search_performance")!;
      await expect(
        executeCapability(
          tool,
          {
            scope: other.owner,
            runId: "test",
            conversationId: "test",
            callIndex: 1,
          },
          query,
        ),
      ).rejects.toMatchObject({ status: 404 });
    });
  },
);
