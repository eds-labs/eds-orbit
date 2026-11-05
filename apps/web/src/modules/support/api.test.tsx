import { describe, expect, it } from "vitest";
import { slaState, ticketQuery, timelineEntries } from "./api";

describe("support web helpers (WP5.2)", () => {
  it("builds the ticket list query, leaving empty filters out", () => {
    expect(
      ticketQuery({ view: "mine", status: "", q: " quokka ", cursor: null }),
    ).toBe("view=mine&q=quokka&openOnly=true");
    expect(ticketQuery({ view: "all", status: "open", cursor: "abc=" })).toBe(
      "view=all&status=open&cursor=abc%3D",
    );
  });

  it("hides resolved and closed tickets unless a status is chosen", () => {
    expect(ticketQuery({ view: "all" })).toBe("view=all&openOnly=true");
    expect(ticketQuery({ view: "all", status: "closed" })).toBe(
      "view=all&status=closed",
    );
    expect(ticketQuery({ view: "all", status: "resolved" })).toBe(
      "view=all&status=resolved",
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

  it("shows an AI note in the reader's language when it has one", () => {
    const summary = {
      id: "m1",
      kind: "system",
      bodyText: "The deposit is missing.",
      bodyTranslations: { de: "Die Einzahlung fehlt." },
      createdAt: "t1",
    };
    const plain = { id: "m2", kind: "system", bodyText: "Old note", createdAt: "t2" };
    expect(timelineEntries([summary, plain], "de")).toMatchObject([
      { bodyText: "Die Einzahlung fehlt." },
      { bodyText: "Old note" },
    ]);
    expect(timelineEntries([summary], "en")).toMatchObject([
      { bodyText: "The deposit is missing." },
    ]);
    expect(timelineEntries([summary])).toMatchObject([
      { bodyText: "The deposit is missing." },
    ]);
  });
});
