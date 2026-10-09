import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { when } from "@/lib/api";
import {
  AssignmentTable,
  UpcomingPostList,
  type AssignmentItem,
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
  const list = (handedOver: string[] = [], canStop = true) =>
    renderToStaticMarkup(
      <UpcomingPostList
        items={[post]}
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

  it("says where a handed-over post can still be removed", () => {
    expect(list(["publication"])).toContain(
      "Bereits an Postiz übergeben – nur dort entfernbar",
    );
  });
});
