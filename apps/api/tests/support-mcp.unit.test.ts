import { describe, expect, it } from "vitest";
import { supportConversationResults } from "../src/modules/support/assistant-results.ts";
import { withPlaceholders } from "../src/modules/support/ai.ts";
import { supportMcpTools } from "../src/modules/support/mcp-tools.ts";
import { can } from "../src/platform/tenancy/permissions.ts";
import {
  SUPPORT_NOTES_READ,
  SUPPORT_TICKETS_READ,
} from "../src/modules/support/permissions.ts";
import { responsesTool } from "../src/modules/agents/tools/registry.ts";
const tool = (name: string) => supportMcpTools.find((t) => t.name === name)!;
describe("Support MCP contracts and validation", () => {
  it("redacts customer names/addresses once without corrupting inserted placeholders", () => {
    const contact = {
      name: "Private Customer",
      email: "customer@example.invalid",
    };
    const source =
      "Private Customer: customer@example.invalid, CUSTOMER, Private.";
    const redacted = withPlaceholders(source, contact);
    expect(redacted).toBe(
      "[customer name]: [customer email], [customer name], [customer name].",
    );
    expect(withPlaceholders(redacted, contact)).toBe(redacted);
    expect(
      withPlaceholders("A.+ B[ee] c@example.invalid", { name: "A.+ B[ee]" }),
    ).toBe("[customer name] [customer email]");
  });
  it("does not project private native draft artifacts after the current module role loses internal read access", async () => {
    for (const scope of [
      { role: "viewer" },
      { role: "editor", moduleRoles: { support: "viewer" } },
      { role: "editor", moduleRoles: { support: "none" } },
    ])
      expect(
        await supportConversationResults(
          {} as any,
          scope as any,
          "synthetic-conversation",
          [],
        ),
      ).toEqual({});
  });
  it("separates public ticket read access from private note/draft access", () => {
    expect(can({ role: "viewer" }, SUPPORT_TICKETS_READ)).toBe(true);
    expect(can({ role: "viewer" }, SUPPORT_NOTES_READ)).toBe(false);
    expect(can({ role: "editor" }, SUPPORT_NOTES_READ)).toBe(true);
  });
  it("keeps each schema strict and usable by the existing model tool adapter", () => {
    for (const t of supportMcpTools) {
      expect(t.parameters.safeParse({ unknownField: true }).success).toBe(
        false,
      );
      expect(() => responsesTool(t), t.name).not.toThrow();
      expect(t.mcpScopes).toEqual(["orbit:support"]);
    }
  });
  it("marks the new tools as read/proposal with explicit project selection", () => {
    for (const name of [
      "support_list_tickets",
      "support_get_ticket",
      "support_list_messages",
      "support_reply_ticket",
      "support_add_internal_note",
    ]) {
      expect(tool(name).mcpProjectRequired).toBe(true);
      expect(tool(name).risk).toBe(
        name.includes("reply") || name.includes("note")
          ? "P_proposal"
          : "R0_read",
      );
    }
  });
  it("rejects invalid service input before entering any database transaction", async () => {
    const ctx = {} as any;
    for (const [name, args] of [
      ["support_list_tickets", { limit: 21 }],
      ["support_list_tickets", { createdFrom: "yesterday" }],
      ["support_get_ticket", { ticketId: "123" }],
      ["support_list_messages", { ticketId: "not-a-uuid" }],
      [
        "support_reply_ticket",
        {
          ticketId: "00000000-0000-4000-8000-000000000001",
          message: "",
          idempotencyKey: "test",
        },
      ],
      [
        "support_add_internal_note",
        {
          ticketId: "00000000-0000-4000-8000-000000000001",
          content: "private",
          idempotencyKey: "test",
          autoApprove: true,
        },
      ],
      [
        "support_update_ticket",
        {
          ticketId: "00000000-0000-4000-8000-000000000001",
          status: "deleted",
          idempotencyKey: "test",
        },
      ],
    ] as const)
      await expect(tool(name).execute(ctx, args)).rejects.toMatchObject({
        name: "ZodError",
      });
  });
  it("rejects an old bodyText field supplied alongside the canonical message/content argument", async () => {
    for (const [name, field] of [
      ["support_reply_ticket", "message"],
      ["support_add_internal_note", "content"],
    ]) {
      await expect(
        tool(name!).execute({} as any, {
          ticketId: "00000000-0000-4000-8000-000000000001",
          [field!]: "Canonical text",
          bodyText: "Override",
          idempotencyKey: "synthetic-alias",
        }),
      ).rejects.toMatchObject({ name: "ZodError" });
    }
  });
  it("validates result envelopes rather than accepting arbitrary ticket/detail properties", () => {
    expect(
      tool("support_get_ticket").outputSchema!.safeParse({
        schemaVersion: 1,
        result: { token: "must never be returned" },
      }).success,
    ).toBe(false);
    expect(
      tool("support_list_messages").outputSchema!.safeParse({
        schemaVersion: 1,
        result: {
          ticketId: "00000000-0000-4000-8000-000000000001",
          order: "asc",
          items: [],
          nextCursor: null,
        },
      }).success,
    ).toBe(true);
  });
});
