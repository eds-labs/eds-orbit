import { describe, expect, it } from "vitest";
import { webRegistry } from "@/modules/registry";
import { defaultHomeLayout, moveHomeWidget } from "./home-layout";
import { availableHomeWidgets } from "./routes";

const states = webRegistry.modules.map(({ id }) => ({
  id,
  enabled: true,
  access: "owner",
}));
const all = availableHomeWidgets(webRegistry, states, {});

describe("home widget registry", () => {
  it("uses unique, valid keys and supplies all ten modules plus system status", () => {
    const ids = all.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        "social.upcoming",
        "webmail.mailboxes",
        "ads.accounts",
        "cms.publishing",
      ]),
    );
    for (const id of ids)
      expect(id).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_-]*$/);
    for (const module of webRegistry.modules)
      for (const widget of module.homeWidgets ?? [])
        expect(widget.id.startsWith(`${module.id}.`)).toBe(true);
  });

  it("keeps the previous cards in order and leaves new ones in the catalog", () => {
    expect(defaultHomeLayout(all).map(({ id }) => id)).toEqual([
      "support.overview",
      "work.overview",
      "issues.overview",
      "marketing.overview",
      "knowledge.overview",
      "finance.overview",
      "platform.system-status",
    ]);
  });

  it("requires availability, activation, role and any declared widget feature", () => {
    const registry = {
      ...webRegistry,
      modules: [
        ...webRegistry.modules,
        {
          id: "new_module",
          displayName: { en: "New", de: "Neu" },
          description: { en: "New", de: "Neu" },
          views: [],
          homeWidgets: [
            {
              id: "new_module.first",
              title: { en: "New", de: "Neu" },
              description: { en: "New", de: "Neu" },
              component: () => null,
              defaultSize: "compact" as const,
              feature: "example",
              minAccess: "editor" as const,
            },
          ],
        },
      ],
    };
    const access = [
      { id: "ads", enabled: true, access: "viewer" },
      { id: "webmail", enabled: false, access: "editor" },
      { id: "cms", enabled: true, access: "none" },
      { id: "social", enabled: true },
      { id: "new_module", enabled: true, access: "editor" },
    ];
    expect(
      availableHomeWidgets(registry, access, {}).map(({ id }) => id),
    ).toEqual(["platform.system-status"]);
    expect(
      availableHomeWidgets(registry, access, { example: true }).map(
        ({ id }) => id,
      ),
    ).toEqual(["platform.system-status", "new_module.first"]);
  });

  it("preserves unavailable widgets when rearranging visible cards", () => {
    const byId = new Map(all.map((widget) => [widget.id, widget]));
    const marketing = { id: "marketing.overview", size: "compact" } as const;
    const hidden = { id: "removed.widget", size: "wide" } as const;
    const social = { id: "social.upcoming", size: "wide" } as const;
    expect(
      moveHomeWidget(
        [marketing, hidden, social],
        byId,
        social.id,
        marketing.id,
      ),
    ).toEqual([social, hidden, marketing]);
  });
});
