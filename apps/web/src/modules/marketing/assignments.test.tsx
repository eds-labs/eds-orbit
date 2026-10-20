import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, when } from "@/lib/api";
import {
  AssignmentTable,
  agentsSurface,
  knownData,
  nextKnown,
  nextSurface,
  refreshOnConflict,
  UpcomingPostList,
  AwaitingOwnerDraftList,
  type AssignmentItem,
  type AwaitingOwnerDraft,
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
  it("shows the confirmed review bound and real admission blocker without inventing a legacy limit", () => {
    const html = render([
      item({
        pendingReviewLimit: 4,
        backlog: { limit: 4, pending: 3, held: 1, available: 0, blocked: true },
      }),
    ]);
    expect(html).toContain("3 warten · 1 reserviert · Limit 4");
    expect(html).toContain("Erstellung wartet auf freie Review-Kapazität");
    expect(render([item()])).toContain("Review-Limit nicht festgelegt");
  });
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
    ownerReleased: false,
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

describe("UpcomingPostList for a post the owner released", () => {
  it("shows no veto deadline but keeps Stop", () => {
    const html = renderToStaticMarkup(
      <UpcomingPostList
        items={[
          {
            id: "publication",
            version: 2,
            status: "intent_created",
            reason: null,
            channel: "x-int",
            channelName: "Synthetic X",
            scheduledAt: "2026-10-10T15:00:00.000Z",
            vetoDeadline: null,
            excerpt: "Beta access is open for product teams.",
            assignmentId: "assignment",
            assignmentName: "Two posts a day",
            ownerReleased: true,
          },
        ]}
        now={Date.parse("2026-10-10T10:00:00.000Z")}
        de
        timezone="Europe/Berlin"
        canStop
        pending={false}
        handedOver={[]}
        onStop={() => {}}
      />,
    );
    expect(html).toContain("Vom Owner freigegeben");
    expect(html).not.toContain("Frist abgelaufen");
    expect(html).toContain(">Stop<");
  });
});

describe("UpcomingPostList for a Postiz draft delivery", () => {
  const draft = (status: string): UpcomingPost => ({
    id: "handoff",
    version: 1,
    status,
    reason: null,
    channel: "x-int",
    channelName: "Synthetic X",
    scheduledAt: "2026-10-10T15:00:00.000Z",
    vetoDeadline: null,
    excerpt: "Beta access is open for product teams.",
    assignmentId: "assignment",
    assignmentName: "Two posts a day",
    ownerReleased: false,
    delivery: "postiz_draft",
  });
  const list = (status: string) =>
    renderToStaticMarkup(
      <UpcomingPostList
        items={[draft(status)]}
        now={Date.parse("2026-10-10T10:00:00.000Z")}
        de
        timezone="Europe/Berlin"
        canStop
        pending={false}
        handedOver={[]}
        onStop={() => {}}
      />,
    );

  it("lists it as a draft in Postiz without Stop and says where to withdraw it", () => {
    const html = list("accepted");
    expect(html).toContain("Entwurf in Postiz");
    expect(html).toContain("Beta access is open for product teams.");
    expect(html).toContain("Zurückziehen nur in Postiz");
    expect(html).not.toContain(">Stop<");
    expect(html).not.toContain("Stop möglich bis");
  });

  it("says a booked draft is on its way and an unclear one needs a check", () => {
    expect(list("queued")).toContain("Wird als Entwurf an Postiz übergeben");
    expect(list("queued")).not.toContain(">Stop<");
    expect(list("outcome_unknown")).toContain("bitte in Postiz prüfen");
  });
});

describe("AssignmentTable delivery", () => {
  it("shows how the posts are delivered", () => {
    expect(render([item()])).toContain(
      "Zustellung: Veröffentlichen nach dem Veto-Fenster",
    );
    expect(render([item({ delivery: "postiz_draft" })])).toContain(
      "Zustellung: Als Entwurf in Postiz (du veröffentlichst selbst)",
    );
  });

  it("shows a shared text and the format (R76, R77)", () => {
    const html = render([
      item({
        sharedAcrossChannels: true,
        format: {
          minChars: 600,
          maxChars: 900,
          hashtags: { min: 2, max: 3 },
          paragraphs: false,
        },
      }),
    ]);
    expect(html).toContain("Ein Text und ein Bild für alle Kanäle");
    expect(html).toContain("Format: 600–900 Zeichen · 2–3 Hashtags");
    const plain = render([item()]);
    expect(plain).not.toContain("Ein Text und ein Bild für alle Kanäle");
    expect(plain).not.toContain("Format:");
  });
});

describe("AssignmentTable banner (R78)", () => {
  it("shows the banner setting only when set", () => {
    const html = render([item({ banner: { template: "brand_landscape" } })]);
    expect(html).toContain("Banner: Markenbanner 16:9 je Termin");
    expect(render([item()])).not.toContain("Banner:");
  });
});

describe("AwaitingOwnerDraftList", () => {
  const draft = (
    changes: Partial<AwaitingOwnerDraft> = {},
  ): AwaitingOwnerDraft => ({
    id: "content",
    version: 4,
    channel: "x-int",
    channelName: "Synthetic X",
    slotAt: "2026-10-10T15:00:00.000Z",
    excerpt: "Beta access is open for product teams.",
    assignmentId: "assignment",
    assignmentName: "Two posts a day",
    agentApproved: true,
    problems: [],
    ...changes,
  });
  const render = (
    items: AwaitingOwnerDraft[],
    canRelease = true,
    onRelease: (item: AwaitingOwnerDraft) => void = () => {},
  ) =>
    renderToStaticMarkup(
      <AwaitingOwnerDraftList
        items={items}
        de
        timezone="Europe/Berlin"
        canRelease={canRelease}
        pending={false}
        onRelease={onRelease}
      />,
    );

  it("lists drafts left for the owner with their slot and a release button for the owner", () => {
    const html = render([draft()]);
    expect(html).toContain("Wartet auf deine Freigabe");
    expect(html).toContain("Beta access is open for product teams.");
    expect(html).toContain("Synthetic X");
    expect(html).toContain("Two posts a day");
    expect(html).toContain(
      when("2026-10-10T15:00:00.000Z", "de", "Europe/Berlin"),
    );
    expect(html).toContain(">Freigeben<");
    expect(html).toContain("Vom Review-Agenten geprüft");
  });

  it("shows what the review left open and offers no button to others", () => {
    const html = render(
      [draft({ agentApproved: false, problems: ["LINK_UNVERIFIED"] })],
      false,
    );
    expect(html).toContain("LINK_UNVERIFIED");
    expect(html).toContain(
      "Der Review-Agent hat diesen Entwurf an dich übergeben",
    );
    expect(html).not.toContain(">Freigeben<");
    expect(html).toContain("Nur ein Owner kann freigeben");
  });

  it("renders nothing without drafts", () => {
    expect(render([])).toBe("");
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

describe("agentsSurface", () => {
  const answer = { items: [] };
  it("is unavailable on any error without an answer, and swaps only on an answer", () => {
    expect(agentsSurface(null, new ApiError("REQUEST_FAILED", 500))).toBe(
      "unavailable",
    );
    expect(agentsSurface(null, new ApiError("BAD_GATEWAY", 502))).toBe(
      "unavailable",
    );
    expect(agentsSurface(null, new ApiError("RATE_LIMITED", 429))).toBe(
      "unavailable",
    );
    expect(agentsSurface(null, new ApiError("NETWORK_ERROR", 0))).toBe(
      "unavailable",
    );
    expect(agentsSurface(null, new ApiError("NOT_FOUND", 404))).toBe(
      "unavailable",
    );
    expect(agentsSurface(answer, null)).toBe("assignments");
    // A confirmed answer kept through a later error stays assignments.
    expect(agentsSurface(answer, new ApiError("REQUEST_FAILED", 503))).toBe(
      "assignments",
    );
    expect(agentsSurface(null, null)).toBe("pending");
  });

  it("keeps the decided surface while the same project reloads, not across projects", () => {
    let known = nextSurface(
      { key: "A", surface: "pending" },
      "A",
      "unavailable",
    );
    expect(known.surface).toBe("unavailable");
    // A refresh: no answer and no error yet.
    known = nextSurface(known, "A", "pending");
    expect(known.surface).toBe("unavailable");
    known = nextSurface(known, "A", "assignments");
    expect(known.surface).toBe("assignments");
    known = nextSurface(known, "B", "pending");
    expect(known.surface).toBe("pending");
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

it("shows the human approval requirement on the management table", () => {
  const html = render([item({ approvalMode: "human_each" })]);
  expect(html).toContain(
    "Jeden Beitrag vor externer Übergabe selbst freigeben",
  );
  expect(html).toContain("Veröffentlichen nach deiner Freigabe");
  expect(html).not.toContain("Veröffentlichen nach dem Veto-Fenster");
});
