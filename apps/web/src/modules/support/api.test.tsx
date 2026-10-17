import { describe, expect, it } from "vitest";
import { slaState, ticketQuery, timelineEntries } from "./api";

describe("support web helpers (WP5.2)", () => {
  it("builds the ticket list query, leaving empty filters out", () => {
    expect(
      ticketQuery({ view: "mine", status: "", q: " quokka ", cursor: null }),
    ).toBe("view=mine&q=quokka");
    expect(ticketQuery({ view: "all", status: "open", cursor: "abc=" })).toBe(
      "view=all&status=open&cursor=abc%3D",
    );
  });

  it("rates the SLA of a ticket", () => {
    const now = new Date("2026-10-18T10:00:00Z");
    const base = {
      status: "open",
      firstRespondedAt: null,
      resolvedAt: null,
      firstResponseDueAt: "2026-10-18T12:00:00Z",
      resolutionDueAt: "2026-10-20T10:00:00Z",
    };
    expect(slaState(base, now)).toBe("ok");
    expect(
      slaState({ ...base, firstResponseDueAt: "2026-10-18T10:30:00Z" }, now),
    ).toBe("at_risk");
    expect(
      slaState({ ...base, firstResponseDueAt: "2026-10-18T09:00:00Z" }, now),
    ).toBe("breached");
    // A met first response no longer counts; waiting on the customer pauses.
    expect(
      slaState(
        {
          ...base,
          firstRespondedAt: "2026-10-18T08:00:00Z",
          firstResponseDueAt: "2026-10-18T09:00:00Z",
        },
        now,
      ),
    ).toBe("ok");
    expect(
      slaState(
        {
          ...base,
          status: "pending_customer",
          firstResponseDueAt: "2026-10-18T09:00:00Z",
        },
        now,
      ),
    ).toBe("paused");
    expect(slaState({ ...base, status: "resolved" }, now)).toBe("done");
  });

  it("splits the timeline into messages and events", () => {
    const entries = timelineEntries([
      { id: "m1", kind: "customer", bodyText: "Hi", createdAt: "t1" },
      {
        id: "e1",
        type: "status",
        before: { status: "new" },
        after: { status: "open" },
        createdAt: "t2",
      },
      { id: "m2", kind: "internal_note", bodyText: "Psst", createdAt: "t3" },
    ]);
    expect(entries.map((e) => [e.entry, e.id])).toEqual([
      ["message", "m1"],
      ["event", "e1"],
      ["message", "m2"],
    ]);
    expect(entries[2]).toMatchObject({ internal: true });
  });
});
