import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, when } from "@/lib/api";
import {
  AssignmentTable,
  AutopilotMigrationView,
  knownData,
  nextKnown,
  refreshOnConflict,
  UpcomingPostList,
  type AssignmentItem,
  type AutopilotMigration,
  type UpcomingPost,
} from "./assignments";

const item = (changes: Partial<AssignmentItem> = {}): AssignmentItem => ({
  id: "assignment",
  version: 3,
  name: "Two posts a day",
  status: "active",
  kind: "standing",
  contentType: "social",
  channels: ["x-int"],
  channelNames: { "x-int": "Synthetic X" },
  schedule: { rhythm: "daily", weekdays: [], times: ["10:00", "17:00"] },
  image: true,
  vetoMinutes: 180,
  nextRunAt: "2026-10-10T02:00:00.000Z",
  monthCostMicros: 1_250_000,
  monthlyBudgetMicros: 30_000_000,
  actionRequestId: null,
  ...changes,
});
const render = (
  items: AssignmentItem[],
  role: "owner" | "editor" | "viewer" = "owner",
) =>
  renderToStaticMarkup(
    <AssignmentTable
      items={items}
      de
      timezone="Europe/Berlin"
      role={role}
      pending={false}
      onStatus={() => {}}
    />,
  );

describe("AssignmentTable", () => {
  it("shows status, next run and budget use", () => {
    const html = render([item()]);
    expect(html).toContain("Two posts a day");
    expect(html).toContain("Aktiv");
    expect(html).toContain(
      when("2026-10-10T02:00:00.000Z", "de", "Europe/Berlin"),
    );
    expect(html).toContain("$1.25 von $30.00");
    expect(html).toContain("Synthetic X");
    expect(html).toContain("10:00, 17:00");
    // The time shown is when the run starts preparing, not the post slot.
    expect(html).toContain("Nächste Vorbereitung");
  });

  it("offers pause and end to editors and resume only to the owner", () => {
    const paused = item({ status: "paused" });
    expect(render([item()], "editor")).toContain("Pausieren");
    expect(render([paused], "editor")).not.toContain("Fortsetzen");
    expect(render([paused], "editor")).toContain("Beenden");
    expect(render([paused], "owner")).toContain("Fortsetzen");
    const viewer = render([item()], "viewer");
    expect(viewer).not.toContain("Pausieren");
    expect(viewer).not.toContain("Beenden");
  });

  it("points a draft to its open confirmation instead of an editor", () => {
    const html = render([
      item({ status: "draft", nextRunAt: null, actionRequestId: "request" }),
    ]);
    expect(html).toContain("Bestätigung offen");
    expect(html).not.toContain("Fortsetzen");
  });
});

describe("UpcomingPostList", () => {
  const post: UpcomingPost = {
    id: "publication",
    version: 2,
    status: "intent_created",
    reason: null,
    channel: "x-int",
    channelName: "Synthetic X",
    scheduledAt: "2026-10-10T15:00:00.000Z",
    vetoDeadline: "2026-10-10T12:00:00.000Z",
    excerpt: "Beta access is open for product teams.",
    assignmentId: "assignment",
    assignmentName: "Two posts a day",
  };
  const list = (
    handedOver: string[] = [],
    canStop = true,
    now = Date.parse("2026-10-10T10:00:00.000Z"),
  ) =>
    renderToStaticMarkup(
      <UpcomingPostList
        items={[post]}
        now={now}
        de
        timezone="Europe/Berlin"
        canStop={canStop}
        pending={false}
        handedOver={handedOver}
        onStop={() => {}}
      />,
    );

  it("lists the post with its deadline and a Stop button", () => {
    const html = list();
    expect(html).toContain("Anstehende Posts");
    expect(html).toContain("Beta access is open for product teams.");
    expect(html).toContain(
      when("2026-10-10T12:00:00.000Z", "de", "Europe/Berlin"),
    );
    expect(html).toContain(">Stop<");
    expect(list([], false)).not.toContain(">Stop<");
  });

  it("says the deadline has passed for a post not handed over yet", () => {
    const html = list([], true, Date.parse("2026-10-10T12:30:00.000Z"));
    expect(html).toContain("Frist abgelaufen");
    expect(html).not.toContain("Stop möglich bis");
  });

  it("says where a handed-over post can still be removed", () => {
    expect(list(["publication"])).toContain(
      "Bereits an Postiz übergeben – nur dort entfernbar",
    );
  });
});

describe("knownData", () => {
  it("keeps the last answer while reloading and forgets it on a 404", () => {
    const first = { items: [1] };
    expect(knownData(null, first, null)).toBe(first);
    // Reloading: no data and no error yet.
    expect(knownData(first, null, null)).toBe(first);
    const next = { items: [2] };
    expect(knownData(first, next, null)).toBe(next);
    expect(knownData(first, null, new ApiError("NOT_FOUND", 404))).toBeNull();
    expect(knownData(first, null, new ApiError("REQUEST_FAILED", 500))).toBe(
      first,
    );
  });
});

describe("nextKnown", () => {
  it("shows nothing of the previous project after a project switch", () => {
    const a = { items: ["project A"] };
    const b = { items: ["project B"] };
    // Project A answered and is kept.
    let known = nextKnown({ key: "A", value: null }, "A", a, null);
    expect(known.value).toBe(a);
    // The render that switches to B still holds A's answer (the reload starts after it).
    known = nextKnown(known, "B", a, null);
    expect(known.value).toBeNull();
    // A later render before the reload cleared it must not bring A back.
    known = nextKnown(known, "B", a, null);
    expect(known.value).toBeNull();
    // B is loading, then answers.
    known = nextKnown(known, "B", null, null);
    expect(known.value).toBeNull();
    known = nextKnown(known, "B", b, null);
    expect(known.value).toBe(b);
    // B reloads (refresh) and keeps its own answer meanwhile.
    known = nextKnown(known, "B", null, null);
    expect(known.value).toBe(b);
  });

  it("ignores the previous project's error on the switch render", () => {
    const a = { items: ["project A"] };
    let known = nextKnown({ key: "A", value: a }, "A", a, null);
    known = nextKnown(known, "B", null, new ApiError("NOT_FOUND", 404));
    expect(known.value).toBeNull();
    const b = { items: ["project B"] };
    known = nextKnown(known, "B", b, null);
    expect(known.value).toBe(b);
  });
});

describe("refreshOnConflict", () => {
  it("reloads after a version conflict and still reports it", async () => {
    const refresh = vi.fn();
    await expect(
      refreshOnConflict(async () => {
        throw new ApiError("VERSION_CONFLICT", 409);
      }, refresh),
    ).rejects.toThrow("VERSION CONFLICT");
    expect(refresh).toHaveBeenCalledOnce();
    await expect(
      refreshOnConflict(async () => {
        throw new ApiError("OWNER_REQUIRED", 403);
      }, refresh),
    ).rejects.toThrow();
    expect(refresh).toHaveBeenCalledOnce();
    expect(await refreshOnConflict(async () => 7, refresh)).toBe(7);
  });
});

describe("AutopilotMigrationView", () => {
  const proposal: NonNullable<AutopilotMigration["proposal"]> = {
    name: "Autopilot (übernommen)",
    kind: "standing",
    contentType: "social",
    channels: ["x-int", "tg-int"],
    schedule: { rhythm: "daily", weekdays: [], times: ["10:00"] },
    topicFrame: "Ein Social-Post pro Kanal und Tag: beta.access",
    image: true,
    styleAssetIds: ["asset"],
    vetoMinutes: 180,
    monthlyBudgetMicros: 50_000_000,
  };
  const view = (
    state: Partial<AutopilotMigration>,
    canPropose = true,
  ) =>
    renderToStaticMarkup(
      <AutopilotMigrationView
        state={{
          proposal,
          channelNames: { "x-int": "Synthetic X" },
          assignment: null,
          ...state,
        }}
        de
        canPropose={canPropose}
        pending={false}
        onPropose={() => {}}
      />,
    );

  it("offers the saved autopilot as an assignment to editors", () => {
    const html = view({});
    expect(html).toContain("Autopilot als Auftrag übernehmen");
    expect(html).toContain("Synthetic X, tg-int");
    expect(html).toContain("Täglich um 10:00");
    expect(html).toContain("$50.00");
    expect(html).toContain("Als Auftrag vorschlagen");
    expect(view({}, false)).not.toContain("Als Auftrag vorschlagen");
  });

  it("points to the open confirmation and disappears once confirmed", () => {
    const draft = view({
      assignment: { id: "a", status: "draft", actionRequestId: "r" },
    });
    expect(draft).toContain("Bestätigung ist offen");
    expect(draft).not.toContain("Als Auftrag vorschlagen");
    expect(
      view({ assignment: { id: "a", status: "active", actionRequestId: null } }),
    ).toBe("");
    expect(view({ proposal: null })).toBe("");
  });
});
