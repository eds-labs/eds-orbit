import { describe, expect, it } from "vitest";
import {
  overduePostizPosts,
  postizQueueHealth,
  POSTIZ_QUEUE_OVERDUE_MS,
} from "./postiz-queue-watch.ts";

const now = new Date("2026-10-02T08:00:00.000Z");
const post = (
  id: string,
  state: string,
  minutesAgo: number,
  integration = "telegram-1",
) => ({
  id,
  state,
  publishDate: new Date(now.valueOf() - minutesAgo * 60_000).toISOString(),
  integration: { id: integration },
});

describe("Postiz queue watch", () => {
  it("reports only queued posts of assigned channels past the grace period", () => {
    const posts = [
      post("late", "QUEUE", 16),
      post("fresh", "QUEUE", 14),
      post("published", "PUBLISHED", 120),
      post("draft", "DRAFT", 120),
      post("error", "ERROR", 120),
      post("other-channel", "QUEUE", 120, "facebook-1"),
      post("future", "QUEUE", -60),
    ];
    expect(
      overduePostizPosts(posts, ["telegram-1"], now).map((p) => p.id),
    ).toEqual(["late"]);
    expect(POSTIZ_QUEUE_OVERDUE_MS).toBe(15 * 60_000);
  });

  it("ignores unparsable dates and an empty channel assignment", () => {
    expect(
      overduePostizPosts(
        [{ ...post("bad", "QUEUE", 60), publishDate: "not a date" }],
        ["telegram-1"],
        now,
      ),
    ).toEqual([]);
    expect(overduePostizPosts([post("late", "QUEUE", 60)], [], now)).toEqual(
      [],
    );
  });

  it("aggregates fresh project results into one public state", () => {
    const at = (status: string, minutesAgo: number) =>
      JSON.stringify({
        status,
        checkedAt: new Date(now.valueOf() - minutesAgo * 60_000).toISOString(),
      });
    expect(postizQueueHealth({}, now)).toBe("unknown");
    expect(postizQueueHealth({ a: at("ok", 5) }, now)).toBe("ok");
    expect(
      postizQueueHealth({ a: at("ok", 5), b: at("stalled", 5) }, now),
    ).toBe("stalled");
    // A result older than three check intervals no longer counts.
    expect(postizQueueHealth({ a: at("stalled", 31) }, now)).toBe("unknown");
    expect(postizQueueHealth({ a: at("unavailable", 5) }, now)).toBe("unknown");
    expect(postizQueueHealth({ a: "{broken" }, now)).toBe("unknown");
  });
});
