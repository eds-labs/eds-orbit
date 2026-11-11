import { describe, expect, it } from "vitest";
import { INTEGRATION_STATES, integrationState, type StateSource } from "../src/platform/connections/integrations.ts";

const central = (o: Partial<Extract<StateSource, { kind: "central" }>>): StateSource => ({
  kind: "central", status: "read_verified", disabled: false, revoked: false, grant: "active", binding: "present", ...o,
});

describe("uniform integration state", () => {
  it("maps central connections", () => {
    expect(integrationState(central({ disabled: true }))).toBe("disabled");
    expect(integrationState(central({ revoked: true }))).toBe("disabled");
    expect(integrationState(central({ grant: "revoked" }))).toBe("disabled");
    expect(integrationState(central({ status: "failed" }))).toBe("needs_attention");
    expect(integrationState(central({ status: "configured" }))).toBe("stored");
    expect(integrationState(central({ status: "something_new" }))).toBe("stored");
    expect(integrationState(central({ grant: "none" }))).toBe("verified");
    expect(integrationState(central({ binding: "missing" }))).toBe("verified");
    expect(integrationState(central({ status: "write_verified", binding: "not_needed" }))).toBe("ready");
    expect(integrationState(central({}))).toBe("ready");
  });
  it("never calls a failed, revoked or disabled record ready", () => {
    for (const o of [{ status: "failed" }, { grant: "revoked" as const }, { disabled: true }, { revoked: true }])
      expect(integrationState(central(o))).not.toBe("ready");
  });
  it("maps project connectors", () => {
    expect(integrationState({ kind: "project_connector", status: null })).toBe("not_set_up");
    expect(integrationState({ kind: "project_connector", status: "revoked" })).toBe("disabled");
    expect(integrationState({ kind: "project_connector", status: "failed" })).toBe("needs_attention");
    expect(integrationState({ kind: "project_connector", status: "read_verified" })).toBe("ready");
    expect(integrationState({ kind: "project_connector", status: "configured" })).toBe("stored");
  });
  it("maps social accounts", () => {
    const s = (status: string, capability = "read_verified") => integrationState({ kind: "social_account", status, capability });
    expect(s("disabled")).toBe("disabled");
    expect(s("reconnect_required", "write_verified")).toBe("needs_attention");
    expect(s("active", "write_verified")).toBe("ready");
    expect(s("active")).toBe("verified");
  });
  it("maps Drive, Telegram and installations", () => {
    const d = (o: Partial<{ connected: boolean; reconnectRequired: boolean; rootConfigured: boolean }>) =>
      integrationState({ kind: "drive", connected: true, reconnectRequired: false, rootConfigured: false, ...o });
    expect(d({ connected: false })).toBe("not_set_up");
    expect(d({ reconnectRequired: true, rootConfigured: true })).toBe("needs_attention");
    expect(d({ rootConfigured: true })).toBe("ready");
    expect(d({})).toBe("verified");
    expect(["none", "pending", "linked", "disabled"].map((status) =>
      integrationState({ kind: "telegram", status: status as "none" }))).toEqual(["not_set_up", "stored", "verified", "disabled"]);
    expect(integrationState({ kind: "installation", configured: true, installed: true })).toBe("ready");
    expect(integrationState({ kind: "installation", configured: true, installed: false })).toBe("stored");
    expect(integrationState({ kind: "installation", configured: false, installed: false })).toBe("not_set_up");
  });
  it("returns only states of the vocabulary", () => {
    expect(INTEGRATION_STATES).toEqual(["not_set_up", "stored", "verified", "ready", "needs_attention", "disabled"]);
  });
});
