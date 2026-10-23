import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { validateRegistry } from "../../../packages/module-contracts/src/index.ts";
import {
  registeredWebhook,
  registerContributions,
  registeredAction,
  registeredActionNames,
  registeredActionType,
  registeredChannelDirectories,
  registeredReadiness,
  registeredHooks,
  registeredImpactHandlers,
  registeredConnectionProvider,
  registeredConnectionProviderIds,
  registeredJobOwner,
  registeredJobs,
  registeredNotification,
  registeredPeriodicTask,
  registeredPeriodicTasks,
  registeredRetention,
  registeredRoutes,
  registeredRoutesByOwner,
  registeredSchedulers,
  registeredTelegramCallback,
  registeredToolOwner,
  registeredTools,
  telegramContributorEnabled,
  unexportedKinds,
  workerStartHooks,
} from "../src/platform/modules/contributions.ts";
import { platformActionPermissions } from "../src/platform/tenancy/permissions.ts";
import { knowledgeActionPermissions } from "../src/modules/knowledge/permissions.ts";
import { marketingActionPermissions } from "../src/modules/marketing/permissions.ts";
import { readiness } from "../src/modules/marketing/readiness/readiness.ts";
import { marketingRoutes } from "../src/modules/marketing/routes.ts";
import { supportRoutes } from "../src/modules/support/routes.ts";
import { knowledgeRoutes } from "../src/modules/knowledge/routes.ts";
import { postizQueueHealth } from "../src/modules/postiz-queue-watch.ts";
import { registerAgentSpecialists } from "../src/modules/agents/specialists/index.ts";
import { marketingHooks } from "../src/modules/marketing/hooks.ts";
import { marketingRetention } from "../src/modules/marketing/retention.ts";
import { platformContributions } from "../src/platform/modules/platform-contributions.ts";
import { publicEntity } from "../src/platform/shared.ts";
import { chatTools } from "../src/modules/agents/tools/index.ts";
import { pauseCallback } from "../src/platform/connections/telegram.ts";
import { stopCallback } from "../src/modules/marketing/agents/telegram-stop.ts";
import { NOTIFY_KINDS } from "../src/modules/marketing/agents/notifications.ts";
import { marketingNotifications } from "../src/modules/marketing/agents/notification-messages.ts";
import { invalidateMarketingForKnowledge } from "../src/modules/marketing/pipeline/knowledge-impact.ts";

/** The platform registries filled from module contributions (WP1.6). */
describe("module contributions", () => {
  it("offers the chat tools unchanged and in their order", () => {
    expect(
      registeredTools()
        .filter((t) => t.feature !== "mcp_tasks")
        .map((t) => t.name),
    ).toEqual(chatTools.map((t) => t.name));
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
        "email_archive",
        "email_send",
        "embedding",
        "finance_extract",
        "finance_mail_receipt",
        "generation",
        "image",
        "index_evaluation",
        "ingestion",
        "knowledge_analysis",
        "postiz_draft",
        "publishing",
        "reconciliation",
        "reindex",
        "slack_notification",
        "support_draft",
        "support_email_inbound",
        "support_triage",
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
      // E-mail (WP4.7): messages, inbound mail and the IMAP position.
      "email_inbound_state",
      "email_messages",
      "evidence",
      // Raw provider webhooks (WP4.2a): operational data, never exported.
      "inbound_emails",
      "inbound_webhooks",
      // Public client sessions with hashed tokens (WP4.2b).
      "knowledge_drafts",
      "knowledge_github_config",
      "knowledge_github_connections",
      "knowledge_github_oauth",
      "knowledge_previews",
      "knowledge_profiles",
      "knowledge_proposals",
      "knowledge_runs",
      "orbit_tasks",
      "public_sessions",
      // Widget visitors (WP5.4): bound to sessions, never exported.
      "support_widget_sessions",
      "telegram_connections",
    ]);
  });

  it("receives Slack and the owner's bot through the hooks route too (WP4.2)", () => {
    expect(registeredWebhook("telegram")).toMatchObject({
      owner: "platform",
      direct: true,
      bodies: ["json"],
    });
    expect(registeredWebhook("slack")).toMatchObject({
      owner: "marketing",
      direct: true,
      bodies: ["form"],
    });
  });

  it("lets marketing extend pause, resume and retention (WP1.8)", () => {
    expect(registeredHooks()).toEqual([marketingHooks]);
    // Platform retention covers ingress and private external work orders.
    expect(registeredRetention()).toEqual([
      platformContributions.retention,
      marketingRetention,
    ]);
  });

  it("binds marketing's knowledge impact handler for every project (WP3.1)", () => {
    // No activation parameter: a revocation must also reach content of a
    // project whose marketing module is switched off (plans 05 §4).
    expect(registeredImpactHandlers.length).toBe(0);
    expect(registeredImpactHandlers()).toEqual([
      invalidateMarketingForKnowledge,
    ]);
  });
  it("fails closed when no module registered its impact handler (WP3.1)", async () => {
    vi.resetModules();
    const fresh = await import("../src/platform/modules/contributions.ts");
    expect(() => fresh.registeredImpactHandlers()).toThrow(
      "MODULE_CONTRIBUTIONS_NOT_REGISTERED",
    );
    const engine = await import("../src/platform/knowledge/engine.ts");
    expect(() =>
      engine.revokeSource({} as never, {} as never, "source"),
    ).toThrow("MODULE_CONTRIBUTIONS_NOT_REGISTERED");
  });
  it("gives the worker its module tasks and start-up through the registry (WP2.1)", () => {
    // Same order as the worker ran them before: Matomo, the Postiz check,
    // then the Drive retry of generated images (a task since WP2.5d). The
    // platform's ingress cleanup comes first (WP4.2 follow-up).
    expect(registeredPeriodicTasks().map((t) => t.name)).toEqual([
      "public-ingress-cleanup",
      "file-cleanup",
      "email-inbound",
      "matomo-schedule",
      "postiz-queue",
      "drive-asset-retry",
    ]);
    // Support's task counts only while support is available (WP5.3, WP5.6).
    process.env.ORBIT_SUPPORT = "true";
    try {
      expect(registeredPeriodicTasks().map((t) => t.name)).toContain(
        "support-email-delivery",
      );
    } finally {
      delete process.env.ORBIT_SUPPORT;
    }
    // The health key and summary of /api/health/postiz stay the same.
    expect(registeredPeriodicTask("postiz-queue")?.health?.summarize).toBe(
      postizQueueHealth,
    );
    expect(workerStartHooks()).toEqual([registerAgentSpecialists]);
  });

  it("dispatches exactly the actions of the former server.ts if-chain (WP2.1f)", () => {
    expect(registeredActionNames().sort()).toEqual([
      "activate-index",
      "adapt-content",
      "add-member",
      "ai-provider-configure",
      "analyze",
      "approve",
      "archive-mission",
      "archive-old-drafts",
      "asset-status",
      "begin-index",
      "brand-approval",
      "build-index",
      "calendar-block",
      "calendar-unblock",
      "community-import",
      "community-link",
      "configure-matomo-schedule",
      "connector",
      "connector-health",
      "correct-metric",
      "customer-context-connect",
      "customer-context-disconnect",
      "editorial-propose-brief",
      "email-connect",
      "email-disconnect",
      "embed-document",
      "evaluate-experiment",
      "evaluate-index",
      "import",
      "import-matomo",
      "import-metrics",
      "knowledge-analysis-cancel",
      "knowledge-analysis-start",
      "knowledge-draft-preview",
      "knowledge-draft-save",
      "knowledge-file-read",
      "knowledge-github-configure",
      "knowledge-github-connect",
      "knowledge-import-commit",
      "knowledge-import-preview",
      "knowledge-import-retry",
      "knowledge-profile-save",
      "knowledge-proposal-decide",
      "memory-lifecycle",
      "openai-configure",
      "pause",
      "postiz-assign-channels",
      "postiz-draft-handoff",
      "postiz-draft-resolve",
      "postiz-test-execute",
      "postiz-test-prepare",
      "postiz-test-reconcile",
      "preference-update",
      "preflight",
      "project-settings",
      "publish",
      "reconcile",
      "render",
      "resolve-exception",
      "restore-draft-cleanup",
      "resume-live-draft-batch",
      "resume-paused-publications",
      "retention",
      "retrieve",
      "retry",
      "review",
      "revoke-document",
      "revoke-source",
      "rollback-index",
      "run-mission",
      "settle-unknown-reservations",
      "slack-configure",
      "slack-digest",
      "source-audiences",
      "source-pause",
      "start-approved-live-draft-batch",
      "start-approved-live-draft-once",
      "stop-experiment",
      "withdraw-fact",
    ]);
    // Each action has exactly one permission, declared by one catalogue.
    const catalogues = [
      platformActionPermissions,
      knowledgeActionPermissions,
      marketingActionPermissions,
    ];
    for (const name of registeredActionNames())
      expect(catalogues.filter((c) => c[name]).length, name).toBe(1);
    expect(catalogues.flatMap((c) => Object.keys(c)).sort()).toEqual(
      registeredActionNames().sort(),
    );
  });

  it("keeps the actions that opened their own transactions outside the shared one", () => {
    expect(
      registeredActionNames()
        .filter((name) => registeredAction(name)!.transaction === "own")
        .sort(),
    ).toEqual([
      "add-member",
      "ai-provider-configure",
      "connector-health",
      "import-matomo",
      "knowledge-analysis-cancel",
      "knowledge-analysis-start",
      "knowledge-draft-preview",
      "knowledge-draft-save",
      "knowledge-file-read",
      "knowledge-github-configure",
      "knowledge-github-connect",
      "knowledge-import-preview",
      "knowledge-profile-save",
      "knowledge-proposal-decide",
      "openai-configure",
      "postiz-draft-handoff",
      "postiz-test-execute",
      "postiz-test-prepare",
      "postiz-test-reconcile",
      "project-settings",
      "render",
      "retrieve",
    ]);
  });

  it("reads readiness and channel names through marketing's contributions (WP2.1f)", () => {
    expect(registeredReadiness()).toBe(readiness);
    expect(registeredChannelDirectories()).toHaveLength(1);
  });

  it("routes Telegram buttons by prefix; the bot runs with Orbit Agents (WP2.5a)", () => {
    expect(registeredTelegramCallback("pause")).toEqual({
      owner: "platform",
      handle: pauseCallback,
    });
    expect(registeredTelegramCallback("stop")).toEqual({
      owner: "marketing",
      handle: stopCallback,
    });
    expect(registeredTelegramCallback("other")).toBeUndefined();
    const before = process.env.ORBIT_AGENTS;
    try {
      process.env.ORBIT_AGENTS = "true";
      expect(telegramContributorEnabled()).toBe(true);
      process.env.ORBIT_AGENTS = "false";
      expect(telegramContributorEnabled()).toBe(false);
    } finally {
      if (before === undefined) delete process.env.ORBIT_AGENTS;
      else process.env.ORBIT_AGENTS = before;
    }
  });

  it("sends marketing's notification kinds through the platform (WP2.5b)", () => {
    for (const kind of NOTIFY_KINDS)
      expect(registeredNotification(kind)).toEqual({
        owner: "marketing",
        render: marketingNotifications.render,
      });
    expect(registeredNotification("unknown")).toBeUndefined();
    expect(registeredJobOwner("telegram_notification")).toBe("platform");
    expect(registeredJobs().get("telegram_notification")).toMatchObject({
      runWhilePaused: true,
      leaseMs: 180000,
    });
  });

  it("offers marketing's connection providers in their former order (WP2.5c)", () => {
    // The platform's mailbox (WP4.7) and customer context (ADR 0011) come first.
    expect(registeredConnectionProviderIds()).toEqual([
      "email",
      "customer_context",
      "postiz",
      "matomo",
      "slack",
    ]);
    expect(registeredConnectionProvider("email")?.owner).toBe("platform");
    expect(registeredConnectionProvider("customer_context")?.owner).toBe(
      "platform",
    );
    for (const id of registeredConnectionProviderIds().slice(2))
      expect(registeredConnectionProvider(id)?.owner).toBe("marketing");
    expect(registeredConnectionProvider("slack")?.check).toBeUndefined();
    expect(registeredConnectionProvider("github")).toBeUndefined();
  });

  it("lets knowledge, marketing and support register their HTTP routes (WP2.1f, WP3.3, WP5.1)", () => {
    // Registry order: knowledge before marketing, which depends on it.
    // Support counts only while ORBIT_SUPPORT is on; the server registers
    // its routes regardless and they answer 404 while it is off.
    expect(registeredRoutes()).toEqual([knowledgeRoutes, marketingRoutes]);
    process.env.ORBIT_SUPPORT = "true";
    try {
      expect(registeredRoutes()).toEqual([
        knowledgeRoutes,
        supportRoutes,
        marketingRoutes,
      ]);
    } finally {
      delete process.env.ORBIT_SUPPORT;
    }
    expect(registeredRoutesByOwner().map(([owner]) => owner)).toContain(
      "support",
    );
    expect(registeredToolOwner("knowledge_search")).toBe("platform");
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
    const task = { name: "check", run: async () => undefined };
    expect(() =>
      registerContributions(
        registry,
        { periodic: [task] },
        { alpha: { periodic: [task] } },
      ),
    ).toThrow("periodic task check registered twice");
    const action = {
      transaction: "own" as const,
      run: async () => undefined,
    };
    expect(() =>
      registerContributions(
        registry,
        { actions: { same: action } },
        { alpha: { actions: { same: action } } },
      ),
    ).toThrow("action same registered twice");
    const direct = {
      direct: true as const,
      bodies: [] as const,
      handle: async () => ({ status: 200 as const }),
    };
    expect(() =>
      registerContributions(
        registry,
        {},
        { alpha: { webhooks: { x1: direct } } },
      ),
    ).toThrow("webhook provider x1 accepts no known body");
    const provider = async () => ({ state: "x", blockers: [] });
    expect(() =>
      registerContributions(
        registry,
        { readiness: provider },
        { alpha: { readiness: provider } },
      ),
    ).toThrow("more than one readiness provider");
    const press = async () => null;
    expect(() =>
      registerContributions(
        registry,
        { telegram: { callbacks: { pause: press } } },
        { alpha: { telegram: { callbacks: { pause: press } } } },
      ),
    ).toThrow("Telegram callback pause registered twice");
    expect(() =>
      registerContributions(
        registry,
        {},
        { alpha: { telegram: { callbacks: { "Stop:": press } } } },
      ),
    ).toThrow("invalid Telegram callback prefix Stop:");
    expect(() =>
      registerContributions(
        registry,
        { connections: { providers: { same: {} } } },
        { alpha: { connections: { providers: { same: {} } } } },
      ),
    ).toThrow("connection provider same registered twice");
    const render = async () => ({ skip: "x" });
    expect(() =>
      registerContributions(
        registry,
        { notifications: { kinds: ["same"], render } },
        { alpha: { notifications: { kinds: ["same", "Bad-Kind"], render } } },
      ),
    ).toThrow(
      "notification kind same registered twice; invalid notification kind Bad-Kind",
    );
  });

  it("refuses a tool exposed to MCP without an output schema, naming it (WP-M2)", () => {
    const registry = validateRegistry(
      [
        {
          id: "alpha",
          version: "1.0.0",
          displayName: { en: "A", de: "A" },
          dependsOn: [],
          defaultEnabled: true,
          entityKinds: [],
          tables: [],
          permissions: [],
        },
      ],
      { entityKinds: [{ kind: "jobs", description: "j" }], tables: [] },
    );
    // A tool of its own: chatTools[0] (project_status) now opts into MCP
    // with a schema of its own, which would hide what this case checks.
    const { outputSchema: _schema, ...base } = chatTools[0]!;
    const exposed = { ...base, name: "alpha_read", exposure: { mcp: true } };
    expect(() =>
      registerContributions(registry, {}, { alpha: { tools: [exposed] } }),
    ).toThrow(
      "MODULE_CONTRIBUTIONS_INVALID: tool alpha_read is exposed to MCP without an output schema",
    );
    // An output schema that is not an object cannot become structuredContent.
    const listed = { ...exposed, outputSchema: z.array(z.string()) };
    expect(() =>
      registerContributions(registry, {}, { alpha: { tools: [listed] } }),
    ).toThrow(
      "MODULE_CONTRIBUTIONS_INVALID: tool alpha_read is exposed to MCP with an output schema that is not an object",
    );
  });
});
