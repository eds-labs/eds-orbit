import { describe, expect, it } from "vitest";
import { validateRegistry } from "../../../packages/module-contracts/src/index.ts";
import { registerModules } from "../src/modules/registry.ts";
import {
  registerContributions,
  registeredConnectionProvider,
  registeredConnectionProviderIds,
  registeredIntegrationDescriptors,
  registeredProjectIntegrations,
} from "../src/platform/modules/contributions.ts";
import { catalogCategories, catalogCategory, integrationCatalog, ownerOnlyIntegrationIds } from "../src/platform/management/integration-catalog.ts";
import { INTEGRATION_AUTH_TYPES, INTEGRATION_CATEGORIES, type IntegrationDescriptor } from "../src/platform/connections/integrations.ts";

registerModules();

const descriptor: IntegrationDescriptor = {
  id: "sample", label: { en: "Sample", de: "Beispiel" }, category: "other", authType: "environment",
  scopes: [], storage: ["environment"], checkable: false,
};
const emptyRegistry = () =>
  validateRegistry([], { entityKinds: [{ kind: "jobs", description: "j" }], tables: [] });

describe("integration registrations", () => {
  it("gives every registered provider a category and auth type from the vocabulary", () => {
    for (const id of registeredConnectionProviderIds()) {
      const provider = registeredConnectionProvider(id)!;
      expect(INTEGRATION_CATEGORIES).toContain(provider.category ?? "other");
      expect(INTEGRATION_AUTH_TYPES).toContain(provider.authType ?? "api_key");
    }
    expect(registeredConnectionProvider("postiz")!.category).toBe("social");
    expect(registeredConnectionProvider("matomo")!.category).toBe("analytics");
    expect(registeredConnectionProvider("openai")!.category).toBe("ai");
    expect(registeredConnectionProvider("social.account.telegram")!.authType).toBe("bot_token");
    expect(registeredConnectionProvider("social.account.x")!.authType).toBe("oauth_account");
    expect(registeredConnectionProvider("issues_webhook")!.authType).toBe("webhook_secret");
  });
  it("registers the descriptors of the integrations outside the provider registry", () => {
    expect(registeredIntegrationDescriptors().map((d) => [d.id, d.owner])).toEqual([
      ["google_drive", "platform"], ["telegram_owner_bot", "platform"], ["mcp_server", "platform"],
      ["system_mail", "platform"], ["knowledge_github", "knowledge"], ["webmail", "webmail"],
    ]);
  });
  it("refuses a descriptor id that is already a provider id", () => {
    expect(() =>
      registerContributions(emptyRegistry(), { integrations: [{ ...descriptor, id: "email" }], connections: { providers: { email: {} } } }, {}),
    ).toThrow(/MODULE_CONTRIBUTIONS_INVALID/);
  });
  it("refuses an invalid or repeated descriptor id, and a category or auth type outside the vocabulary", () => {
    const attempt = (c: Parameters<typeof registerContributions>[1]) =>
      () => registerContributions(emptyRegistry(), c, {});
    expect(attempt({ integrations: [{ ...descriptor, id: "Bad Id" }] })).toThrow(/invalid integration/);
    expect(attempt({ integrations: [descriptor, descriptor] })).toThrow(/registered twice/);
    expect(attempt({ integrations: [{ ...descriptor, category: "nope" as "other" }] })).toThrow(/category/);
    expect(attempt({ integrations: [{ ...descriptor, authType: "nope" as "environment" }] })).toThrow(/auth type/);
    expect(attempt({ connections: { providers: { p: { category: "nope" as "other" } } } })).toThrow(/category/);
    expect(attempt({ connections: { providers: { p: { authType: "nope" as "api_key" } } } })).toThrow(/auth type/);
  });

  it("marks an entry available only while its module is installed", () => {
    const before = process.env.ORBIT_SOCIAL;
    const connections = process.env.ORBIT_CONNECTIONS;
    try {
      // The Meta app is stored centrally only: it also needs central connections.
      process.env.ORBIT_CONNECTIONS = "true";
      process.env.ORBIT_SOCIAL = "false";
      expect(integrationCatalog().find((e) => e.id === "social.app.meta")!.available).toBe(false);
      process.env.ORBIT_SOCIAL = "true";
      expect(integrationCatalog().find((e) => e.id === "social.app.meta")!.available).toBe(true);
    } finally {
      if (before === undefined) delete process.env.ORBIT_SOCIAL;
      else process.env.ORBIT_SOCIAL = before;
      if (connections === undefined) delete process.env.ORBIT_CONNECTIONS;
      else process.env.ORBIT_CONNECTIONS = connections;
    }
  });
  it("stores Postiz centrally and per project, Drive per project, system mail in the environment", () => {
    const by = (id: string) => integrationCatalog().find((e) => e.id === id)!;
    expect(by("postiz").storage).toEqual(["central", "project"]);
    expect(by("google_drive").storage).toEqual(["project"]);
    expect(by("system_mail").storage).toEqual(["environment"]);
    expect(by("social.app.meta").authType).toBe("oauth_app");
    expect(by("social.app.x").authType).toBe("oauth_app");
  });
  it("lists nothing without code", () => {
    expect(integrationCatalog().map((e) => e.id)).not.toContain("tiktok");
  });
  it("orders by category, then label", () => {
    const items = integrationCatalog();
    const key = (e: (typeof items)[number]) => [INTEGRATION_CATEGORIES.indexOf(e.category), e.label.en] as const;
    for (let i = 1; i < items.length; i++) {
      const [ca, la] = key(items[i - 1]!), [cb, lb] = key(items[i]!);
      expect(ca < cb || (ca === cb && la.localeCompare(lb) <= 0)).toBe(true);
    }
  });
  it("falls back to the category other for an unknown id", () => {
    expect(catalogCategory("unknown-id")).toBe("other");
    expect(catalogCategory("postiz")).toBe("social");
    expect(catalogCategories().get("matomo")).toBe("analytics");
  });
  it("lists the social and knowledge project contributions", () => {
    expect(registeredProjectIntegrations().map(([owner]) => owner)).toEqual(["knowledge", "social"]);
  });
  it("follows the knowledge workspace switch for Knowledge GitHub", () => {
    const before = process.env.ORBIT_KNOWLEDGE_WORKSPACE;
    try {
      process.env.ORBIT_KNOWLEDGE_WORKSPACE = "false";
      expect(integrationCatalog().find((e) => e.id === "knowledge_github")!.available).toBe(false);
      process.env.ORBIT_KNOWLEDGE_WORKSPACE = "true";
      expect(integrationCatalog().find((e) => e.id === "knowledge_github")!.available).toBe(true);
    } finally {
      if (before === undefined) delete process.env.ORBIT_KNOWLEDGE_WORKSPACE;
      else process.env.ORBIT_KNOWLEDGE_WORKSPACE = before;
    }
  });
  it("marks exactly the owner-gated descriptors as visible to project owners", () => {
    expect(
      registeredIntegrationDescriptors()
        .filter((d) => d.visibleTo === "owner")
        .map((d) => d.id),
    ).toEqual(["telegram_owner_bot", "knowledge_github"]);
    expect([...ownerOnlyIntegrationIds()]).toEqual(["telegram_owner_bot", "knowledge_github"]);
  });
  it("says whether the central path works in this installation", () => {
    const keys = ["ORBIT_CONNECTIONS", "ORBIT_CONNECTIONS_CUTOVER", "ORBIT_SOCIAL"] as const;
    const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const by = (id: string) => integrationCatalog().find((e) => e.id === id)!;
    try {
      process.env.ORBIT_SOCIAL = "true";
      process.env.ORBIT_CONNECTIONS = "false";
      process.env.ORBIT_CONNECTIONS_CUTOVER = "postiz,matomo";
      // Connections off: no central path at all; central-only entries are switched off.
      for (const id of ["openai", "anthropic", "n8n", "social.app.meta"]) {
        expect(by(id), id).toMatchObject({ centralUsable: false, available: false });
      }
      // Postiz still works through the project's own connection.
      expect(by("postiz")).toMatchObject({ centralUsable: false, available: true });
      // Project-only entries never have a central path.
      expect(by("google_drive")).toMatchObject({ centralUsable: false, available: true });
      expect(by("slack").centralUsable).toBe(false);

      process.env.ORBIT_CONNECTIONS = "true";
      expect(by("openai")).toMatchObject({ centralUsable: true, available: true });
      expect(by("postiz")).toMatchObject({ centralUsable: true, available: true });
      expect(by("matomo").centralUsable).toBe(true);
      // A provider with a project path needs its cutover; one without needs none.
      process.env.ORBIT_CONNECTIONS_CUTOVER = "matomo";
      expect(by("postiz")).toMatchObject({ centralUsable: false, available: true });
      expect(by("matomo").centralUsable).toBe(true);
      expect(by("openai").centralUsable).toBe(true);
      expect(by("customer_context").centralUsable).toBe(false);
      process.env.ORBIT_CONNECTIONS_CUTOVER = "";
      expect(by("email").centralUsable).toBe(false);
      expect(by("social.app.meta")).toMatchObject({ centralUsable: true, available: true });
    } finally {
      for (const k of keys) {
        if (before[k] === undefined) delete process.env[k];
        else process.env[k] = before[k];
      }
    }
  });
  it("gives every provider a readable label", () => {
    for (const id of registeredConnectionProviderIds())
      expect(registeredConnectionProvider(id)!.label, id).toBeDefined();
    expect(integrationCatalog().find((e) => e.id === "email")!.label).toEqual({ en: "E-mail mailbox", de: "E-Mail-Postfach" });
    expect(integrationCatalog().find((e) => e.id === "slack")!.label.en).toBe("Slack");
    // n8n writes its own name in lower case; no other label is just the id.
    expect(integrationCatalog().filter((e) => e.label.en === e.id).map((e) => e.id)).toEqual(["n8n"]);
  });
});
