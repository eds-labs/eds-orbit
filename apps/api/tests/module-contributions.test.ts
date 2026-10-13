import { describe, expect, it } from "vitest";
import { validateRegistry } from "../../../packages/module-contracts/src/index.ts";
import {
  registerContributions,
  registeredActionType,
  registeredHooks,
  registeredJobs,
  registeredRetention,
  registeredSchedulers,
  registeredTools,
  unexportedKinds,
} from "../src/platform/modules/contributions.ts";
import { marketingHooks } from "../src/modules/marketing/hooks.ts";
import { marketingRetention } from "../src/modules/marketing/retention.ts";
import { publicEntity } from "../src/platform/shared.ts";
import { chatTools } from "../src/modules/agents/tools/index.ts";

/** The platform registries filled from module contributions (WP1.6). */
describe("module contributions", () => {
  it("offers the chat tools unchanged and in their order", () => {
    expect(registeredTools().map((t) => t.name)).toEqual(
      chatTools.map((t) => t.name),
    );
  });

  it("registers the four action types and every worker queue class once", () => {
    for (const type of [
      "image.generate",
      "content_package.start",
      "content.schedule",
      "assignment.confirm",
    ])
      expect(registeredActionType(type)).toBeDefined();
    expect(registeredActionType("unknown.type")).toBeUndefined();
    expect([...registeredJobs().keys()].sort()).toEqual(
      [
        "agent",
        "analytics",
        "chat",
        "embedding",
        "generation",
        "image",
        "index_evaluation",
        "ingestion",
        "postiz_draft",
        "publishing",
        "reconciliation",
        "reindex",
        "slack_notification",
        "telegram_notification",
      ].sort(),
    );
    const jobs = registeredJobs();
    expect(jobs.get("publishing")?.concurrency).toBe(2);
    expect(jobs.get("telegram_notification")?.runWhilePaused).toBe(true);
    expect([
      jobs.get("agent")?.leaseMs,
      jobs.get("telegram_notification")?.leaseMs,
      jobs.get("chat")?.leaseMs,
    ]).toEqual([180000, 180000, undefined]);
    expect(
      ["publishing", "slack_notification", "postiz_draft"].every(
        (q) => jobs.get(q)?.onLeaseExpired,
      ),
    ).toBe(true);
  });

  it("runs the marketing sweep before the platform's source sync, as before", () => {
    expect(registeredSchedulers()).toHaveLength(2);
  });

  it("leaves the same kinds out of the project export as before (WP1.8)", () => {
    expect([...unexportedKinds()].sort()).toEqual([
      "connectors",
      "drive_connection",
      "drive_oauth_state",
      "evidence",
      "telegram_connections",
    ]);
  });

  it("lets marketing extend pause, resume and retention (WP1.8)", () => {
    expect(registeredHooks()).toEqual([marketingHooks]);
    expect(registeredRetention()).toEqual([marketingRetention]);
  });

  it("projects module kinds through the module: asset bytes never leave", () => {
    const view = publicEntity({
      kind: "assets",
      data: { name: "logo", base64: "AAAA" },
    });
    expect(view.data).toEqual({ name: "logo", hasContent: true });
    const connector = publicEntity({
      kind: "connectors",
      data: { provider: "postiz", encryptedCredential: "x" },
    });
    expect(connector.data).toEqual({ provider: "postiz" });
  });

  it("refuses duplicate names, unknown modules and projections of foreign kinds", () => {
    const registry = validateRegistry(
      [
        {
          id: "alpha",
          version: "1.0.0",
          displayName: { en: "A", de: "A" },
          dependsOn: [],
          defaultEnabled: true,
          entityKinds: [{ kind: "alpha_kind", description: "a" }],
          tables: [],
          permissions: [],
        },
      ],
      { entityKinds: [{ kind: "jobs", description: "j" }], tables: [] },
    );
    const job = { queueClass: "same", handler: async () => undefined };
    expect(() =>
      registerContributions(
        registry,
        { jobs: [job] },
        { alpha: { jobs: [job] } },
      ),
    ).toThrow("queue class same registered twice");
    expect(() => registerContributions(registry, {}, { beta: {} })).toThrow(
      "contributions for unknown module beta",
    );
    expect(() =>
      registerContributions(
        registry,
        {},
        { alpha: { publicViews: { jobs: (r) => r } } },
      ),
    ).toThrow("alpha projects entity kind jobs it does not own");
  });
});
