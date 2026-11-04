import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerModules } from "../src/modules/registry.ts";
import {
  screenTicketText,
  supportEventMatches,
} from "../src/modules/support/agent-events.ts";
import { supportApplyTriage } from "../src/modules/support/agent-tools.ts";
import { supportAgentTemplates } from "../src/modules/support/agent-template.ts";
import { supportModelText } from "../src/modules/support/ai.ts";
import {
  assertProviderAllowedForData,
  strictestDataClass,
} from "../src/platform/ai/data-class.ts";
import { AgentConfig } from "../src/platform/agents/definitions/schema.ts";
import { assertTemplateRules } from "../src/platform/agents/definitions/templates.ts";
import { modePermits } from "../src/platform/agents/principal.ts";
import { registeredTools } from "../src/platform/modules/contributions.ts";

registerModules();

const INBOX = "11111111-1111-4111-8111-111111111111";
const event = (data: Record<string, unknown> = {}) => ({
  ticketId: "t",
  inboxId: INBOX,
  channel: "email",
  verifiedIdentity: false,
  hardRuleHit: false,
  agentMode: true,
  ...data,
});

describe("Support agent rules (ADR 0021 Phase 2)", () => {
  const before = process.env.ORBIT_SUPPORT;
  beforeAll(() => {
    process.env.ORBIT_SUPPORT = "true";
  });
  afterAll(() => {
    if (before === undefined) delete process.env.ORBIT_SUPPORT;
    else process.env.ORBIT_SUPPORT = before;
  });
  it("never matches a hard-rule hit, an unverified widget visitor or a non-agent inbox, whatever the filter", () => {
    expect(supportEventMatches({}, event())).toBe(true);
    expect(supportEventMatches({}, event({ hardRuleHit: true }))).toBe(false);
    expect(supportEventMatches({}, event({ agentMode: false }))).toBe(false);
    expect(supportEventMatches({}, event({ channel: "widget" }))).toBe(false);
    expect(supportEventMatches({}, event({ channel: "widget", verifiedIdentity: true }))).toBe(true);
    // A missing flag counts as a hit.
    const { hardRuleHit: _h, ...noFlag } = event();
    expect(supportEventMatches({}, noFlag)).toBe(false);
    expect(supportEventMatches({ inboxIds: [INBOX] }, event())).toBe(true);
    expect(supportEventMatches({ inboxIds: ["22222222-2222-4222-8222-222222222222"] }, event())).toBe(false);
    expect(supportEventMatches({ channels: ["widget"] }, event())).toBe(false);
  });

  it("screens the subject with the message (T2-3) and removes identity and platform redaction classes", () => {
    expect(screenTicketText("Refund for order", "Hello").sensitive).toBe(true);
    expect(screenTicketText("Hello", "Hello").sensitive).toBe(false);
    const out = supportModelText(
      "Anna here, anna.k@example.org, +49 151 23456789, IBAN DE89 3704 0044 0532 0130 00, 192.168.10.20",
      { name: "Anna Kowalski", email: "anna.k@example.org" },
    );
    for (const leak of ["Anna", "anna.k@example.org", "23456789", "DE89", "192.168.10.20"])
      expect(out).not.toContain(leak);
    expect(out).toContain("[customer name]");
  });

  it("D-11: allows only OpenAI for customer data, and binds agents whose tools return it", () => {
    expect(() => assertProviderAllowedForData("openai", "customer_personal")).not.toThrow();
    expect(() => assertProviderAllowedForData("anthropic", "customer_personal")).toThrow(
      "AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA",
    );
    expect(() => assertProviderAllowedForData("anthropic", undefined)).not.toThrow();
    const tools = registeredTools();
    const support = tools.filter((t) => t.exposure?.agent && t.name.startsWith("support_"));
    expect(support.length).toBeGreaterThanOrEqual(15);
    expect(support.every((t) => t.catalog?.dataClass === "customer_personal")).toBe(true);
    expect(strictestDataClass(support)).toBe("customer_personal");
    expect(strictestDataClass(tools.filter((t) => t.name === "knowledge_sources"))).toBeUndefined();
  });

  it("offers the pipelines from mode draft, the hand-off only in execute, and the paid tools to agents only", () => {
    const tool = (name: string) => registeredTools().find((t) => t.name === name)!;
    for (const name of ["support_triage_suggest", "support_draft_generate"]) {
      expect(modePermits("read", tool(name).risk, tool(name).agentMinMode)).toBe(false);
      expect(modePermits("draft", tool(name).risk, tool(name).agentMinMode)).toBe(true);
      expect(tool(name).exposure).toEqual({ assistant: false, mcp: false, agent: true });
    }
    expect(modePermits("draft", tool("support_hand_off").risk, tool("support_hand_off").agentMinMode)).toBe(false);
    expect(modePermits("execute", tool("support_hand_off").risk)).toBe(true);
    // Aliases for older outside clients are never offered to agents.
    expect(tool("support_reply_ticket").exposure?.agent).toBeFalsy();
    expect(tool("support_add_internal_note").exposure?.agent).toBeFalsy();
  });

  it("T2-4: a triage mandate never covers a downgrade from urgent, nor a request without its stored before-values", () => {
    const check = supportApplyTriage.action.mandate!.check!;
    const payload = (args: Record<string, unknown>, before?: Record<string, unknown>) => ({
      actorId: "u",
      args: { ticketId: INBOX, ...args },
      idempotencyKey: "k",
      ceilingMicros: 0,
      ...(before ? { approvalContext: { before } } : {}),
    });
    const terms = {} as never;
    const before = (priority: string) => ({ priority, category: null, tags: [] });
    expect(check(payload({ priority: "high" }, before("normal")), terms)).toEqual([]);
    expect(check(payload({ priority: "low" }, before("urgent")), terms)).toEqual(["PRIORITY_DOWNGRADE_NOT_COVERED"]);
    expect(check(payload({ tags: ["crypto"] }, before("urgent")), terms)).toEqual([]);
    expect(check(payload({ priority: "high" }), terms)).toEqual(["PAYLOAD_NOT_COVERED"]);
    // Status and assignee are not even part of the input.
    expect(check(payload({ status: "closed" }, before("normal")), terms)).toEqual(["PAYLOAD_NOT_COVERED"]);
  });

  it("keeps the template valid and caps its mode at execute", () => {
    const [template] = supportAgentTemplates;
    const config = AgentConfig.parse({ ...template!.defaults, templateKey: template!.key });
    expect(() => assertTemplateRules(config)).not.toThrow();
    expect(config.tools).not.toContain("support_send_reply");
    expect(template!.guard.lockedInstructions).toContain("Never send a reply yourself");
  });
});
