import { afterEach, describe, expect, it } from "vitest";
import {
  defaultEntitlements,
  entitled,
  entitlementsFor,
  requireEntitlement,
  setEntitlementsResolver,
} from "../src/platform/entitlements/entitlements.ts";
import { DomainError } from "../src/platform/shared.ts";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";

/** The entitlements port (ADR 0021, agent platform plan §2.9, D-12). */
describe("entitlements port", () => {
  afterEach(() => setEntitlementsResolver());

  it("gives every workspace the unlimited code default", async () => {
    const e = await entitlementsFor(WORKSPACE);
    expect(e.agentsMax).toBeNull();
    expect(e.agentsAutomation).toBe(true);
    expect([...e.agentTriggerKinds].sort()).toEqual([
      "event",
      "manual",
      "schedule",
    ]);
    expect(e.modulesAllowed).toBeNull();
    expect(e.modelsAllowed).toBeNull();
    expect(e.assistantPersonal).toBe(true);
    expect(e.assistantVoice).toBe(true);
    expect(e.integrationsAdvanced).toBe(true);
  });

  it("allows every requirement by default", async () => {
    await expect(
      requireEntitlement(
        WORKSPACE,
        "agentsAutomation",
        "assistantVoice",
        { triggerKind: "event" },
        { module: "support" },
        { model: "any-model" },
      ),
    ).resolves.toMatchObject({ agentsMax: null });
  });

  it("refuses a false yes-or-no entitlement with AGENT_ENTITLEMENT 403", async () => {
    setEntitlementsResolver(() => ({
      ...defaultEntitlements(),
      agentsAutomation: false,
    }));
    const error = await requireEntitlement(WORKSPACE, "agentsAutomation").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code: "AGENT_ENTITLEMENT", status: 403 });
    // Other entitlements are unaffected.
    await expect(
      requireEntitlement(WORKSPACE, "assistantPersonal"),
    ).resolves.toBeDefined();
  });

  it("refuses a trigger kind, module or model outside the allowed sets", async () => {
    setEntitlementsResolver(async (workspaceId) => ({
      ...defaultEntitlements(),
      agentTriggerKinds: new Set(["manual"] as const),
      modulesAllowed: new Set(["support"]),
      modelsAllowed: new Set([`model-of-${workspaceId}`]),
    }));
    const e = await entitlementsFor(WORKSPACE);
    expect(entitled(e, { triggerKind: "manual" })).toBe(true);
    expect(entitled(e, { triggerKind: "schedule" })).toBe(false);
    expect(entitled(e, { module: "support" })).toBe(true);
    expect(entitled(e, { module: "marketing" })).toBe(false);
    expect(entitled(e, { model: `model-of-${WORKSPACE}` })).toBe(true);
    expect(entitled(e, { model: "other" })).toBe(false);
    for (const requirement of [
      { triggerKind: "event" as const },
      { module: "marketing" },
      { model: "other" },
    ])
      await expect(
        requireEntitlement(WORKSPACE, requirement),
      ).rejects.toMatchObject({ code: "AGENT_ENTITLEMENT", status: 403 });
  });

  it("restores the code default when the override is removed", async () => {
    setEntitlementsResolver(() => ({
      ...defaultEntitlements(),
      agentsMax: 3,
    }));
    expect((await entitlementsFor(WORKSPACE)).agentsMax).toBe(3);
    setEntitlementsResolver();
    expect((await entitlementsFor(WORKSPACE)).agentsMax).toBeNull();
  });
});
