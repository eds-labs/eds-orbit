import { describe, expect, it } from "vitest";
import { listTickets } from "./workspace.ts";

const scope = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  userId: "user",
} as never;
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const ticket = (id: string) => ({
  id,
  contactId: "00000000-0000-4000-8000-0000000000c1",
  updatedAt: new Date("2026-10-18T10:00:00.000Z"),
  firstResponseDueAt: null,
  firstRespondedAt: null,
  resolutionDueAt: null,
  resolvedAt: null,
});

describe("listTickets by SLA", () => {
  it("skips a ticket erased between the id query and the reload", async () => {
    // The id query still saw A; by the reload only B is left.
    const tx = {
      $queryRaw: async () => [{ id: A }, { id: B }],
      supportTicket: { findMany: async () => [ticket(B)] },
      supportContact: { findMany: async () => [] },
    } as never;
    const result = await listTickets(tx, scope, { sort: "sla" });
    expect(result.items.map((t) => t.id)).toEqual([B]);
    expect(result.nextCursor).toBeNull();
  });

  it("keeps paging when the extra ticket was erased between the reads", async () => {
    // A page of two: the id query saw A, B and C (one more than the page),
    // but C is gone by the reload. More tickets may follow it.
    const existing = [A, B];
    const tx = {
      $queryRaw: async () => [{ id: A }, { id: B }, { id: C }],
      supportTicket: {
        findMany: async (args: { where: { id: { in: string[] } } }) =>
          existing.filter((id) => args.where.id.in.includes(id)).map(ticket),
      },
      supportContact: { findMany: async () => [] },
    } as never;
    const result = await listTickets(tx, scope, { sort: "sla", limit: 2 });
    expect(result.items.map((t) => t.id)).toEqual([A, B]);
    expect(result.nextCursor).not.toBeNull();
  });
});
