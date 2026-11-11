import { describe, expect, it } from "vitest";
import { validateRegistry } from "../../../packages/module-contracts/src/index.ts";
import { registerModules } from "../src/modules/registry.ts";
import {
  registerContributions,
  registeredConnectionProvider,
  registeredConnectionProviderIds,
  registeredIntegrationDescriptors,
} from "../src/platform/modules/contributions.ts";
import { catalogCategory, integrationCatalog } from "../src/platform/management/integration-catalog.ts";
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
    try {
      process.env.ORBIT_SOCIAL = "false";
      expect(integrationCatalog().find((e) => e.id === "social.app.meta")!.available).toBe(false);
      process.env.ORBIT_SOCIAL = "true";
      expect(integrationCatalog().find((e) => e.id === "social.app.meta")!.available).toBe(true);
    } finally {
      if (before === undefined) delete process.env.ORBIT_SOCIAL;
      else process.env.ORBIT_SOCIAL = before;
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
  });
});
