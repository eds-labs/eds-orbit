import { describe, expect, it } from "vitest";
import { registeredTools } from "../src/platform/modules/contributions.ts";
import {
  availableTools,
  exposedToAssistant,
  responsesTool,
  type ToolFeature,
} from "../src/modules/agents/tools/registry.ts";
import {
  ANTHROPIC_STRICT_LIMITS,
  strictSchemaCost,
  toAnthropicTools,
} from "../../../packages/ai/src/providers/anthropic.ts";

// The assistant's tools for a Claude route stay within Anthropic's strict
// schema limits with every tool feature on (configuration, administration,
// tasks): beyond them the provider refuses the whole request.

describe("Claude chat tools within the strict limits", () => {
  it("sends every offered tool, strict only within the limits", async () => {
    const features: ToolFeature[] = [
      "content_packages",
      "agents",
      "mcp_tasks",
      "project_configuration",
      "project_administration",
    ];
    const offered = registeredTools().filter(
      (tool) => exposedToAssistant(tool) && availableTools([tool], "owner", features).length,
    );
    const tools = toAnthropicTools(offered.map(responsesTool)) as Array<{
      name: string;
      strict?: boolean;
      input_schema: unknown;
    }>;
    expect(tools.map((t) => t.name)).toEqual(offered.map((t) => t.name));
    const strict = tools.filter((t) => t.strict);
    const cost = strict.reduce(
      (sum, t) => {
        const c = strictSchemaCost(t.input_schema);
        return { optional: sum.optional + c.optional, unions: sum.unions + c.unions };
      },
      { optional: 0, unions: 0 },
    );
    (await import("node:fs")).appendFileSync("/private/tmp/claude-501/-Users-marioeuchner-EDS-Labs-Development-EDS-Orbit--claude-worktrees-distracted-austin-82c50c/6ee2d1cd-fd79-42d6-a506-f0553b60ebf4/scratchpad/strict.txt", JSON.stringify({ strict: strict.map((t) => t.name), loose: tools.filter((t) => !t.strict).map((t) => t.name) }));
    expect(strict.length).toBeGreaterThan(0);
    expect(strict.length).toBeLessThanOrEqual(ANTHROPIC_STRICT_LIMITS.tools);
    expect(cost.optional).toBeLessThanOrEqual(ANTHROPIC_STRICT_LIMITS.optionalParameters);
    expect(cost.unions).toBeLessThanOrEqual(ANTHROPIC_STRICT_LIMITS.unionParameters);
  });
});
