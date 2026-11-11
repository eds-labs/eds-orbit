import { describe, expect, it } from "vitest";
import { validateRegistry } from "../../../packages/module-contracts/src/index.ts";
import { registerModules } from "../src/modules/registry.ts";
import {
  registerContributions,
  registeredConnectionProvider,
  registeredConnectionProviderIds,
  registeredIntegrationDescriptors,
} from "../src/platform/modules/contributions.ts";
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
});
