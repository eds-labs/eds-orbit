import { describe, expect, it } from "vitest";
import { hash } from "../../shared.ts";
import { assignmentHash, assignmentInput } from "./assignments.ts";
import {
  FORMAT_HASHTAGS,
  FORMAT_LENGTH,
  formatInstruction,
  formatProblems,
  hashtagCount,
  lengthRange,
} from "./post-format.ts";
import { groupSlots, slotGroups } from "./shared-posts.ts";

// An assignment as stored before R73/R76/R77: none of the later fields.
const legacy = {
  name: "Two posts a day",
  kind: "standing",
  schedule: {
    rhythm: "daily",
    weekdays: [],
    times: ["10:00", "17:00"],
    leadMinutes: 360,
  },
  contentType: "social",
  channels: ["x-int", "tg-int"],
  topicFrame: "Short updates about beta access for product teams",
  image: true,
  styleAssetIds: [],
  vetoMinutes: 180,
  monthlyBudgetMicros: 10_000_000,
};
const format = {
  minChars: 600,
  maxChars: 900,
  hashtags: { min: 2, max: 3 },
  paragraphs: true,
  cta: "https://desk.example.invalid/en/register",
};

describe("assignment hash with shared text and format (R76, R77)", () => {
  it("keeps the hash of rows from before the fields", () => {
    const before = assignmentHash(legacy);
    // The content the hash covered until now: the fields themselves, nothing added.
    expect(before).toBe(hash(legacy));
    expect(assignmentHash({ ...legacy, sharedAcrossChannels: false })).toBe(
      before,
    );
    expect(assignmentHash({ ...legacy, delivery: "publish" })).toBe(before);
    expect(
      assignmentHash({
        ...legacy,
        delivery: "publish",
        sharedAcrossChannels: false,
        format: undefined,
      }),
    ).toBe(before);
  });

  it("covers a shared text and a format", () => {
    const before = assignmentHash(legacy);
    const shared = assignmentHash({ ...legacy, sharedAcrossChannels: true });
    const formatted = assignmentHash({ ...legacy, format });
    expect(shared).not.toBe(before);
    expect(formatted).not.toBe(before);
    expect(formatted).not.toBe(shared);
    expect(
      assignmentHash({ ...legacy, format: { ...format, maxChars: 950 } }),
    ).not.toBe(formatted);
    // Key order (as JSONB stores it) does not matter.
    const { cta, paragraphs, hashtags, maxChars, minChars } = format;
    expect(
      assignmentHash({
        ...legacy,
        format: { cta, paragraphs, hashtags, maxChars, minChars },
      }),
    ).toBe(formatted);
  });

  it("validates the fields for social assignments only", () => {
    expect(
      assignmentInput.safeParse({
        ...legacy,
        sharedAcrossChannels: true,
        format,
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...legacy, contentType: "blog", sharedAcrossChannels: true },
      { ...legacy, contentType: "blog", format },
      { ...legacy, format: { ...format, minChars: 1000 } },
      { ...legacy, format: { ...format, hashtags: { min: 4, max: 3 } } },
      { ...legacy, format: { ...format, cta: "http://desk.example.invalid" } },
      { ...legacy, format: { ...format, extra: true } },
    ])
      expect(assignmentInput.safeParse(invalid).success).toBe(false);
  });
});

describe("format checks (R77)", () => {
  const body = (length: number, tags = " #beta #teams") =>
    `${"a".repeat(length - tags.length)}${tags}`;

  it("checks the length with a tenth of room below and a twentieth above", () => {
    expect(lengthRange(format)).toEqual({ min: 540, max: 945 });
    expect(formatProblems(body(700), format)).toEqual([]);
    expect(formatProblems(body(540), format)).toEqual([]);
    expect(formatProblems(body(945), format)).toEqual([]);
    expect(formatProblems(body(539), format)).toEqual([FORMAT_LENGTH]);
    expect(formatProblems(body(946), format)).toEqual([FORMAT_LENGTH]);
    // UTF-16 units, as Telegram counts its caption: an emoji counts twice;
    // surrounding space does not count.
    expect(formatProblems(`  ${"😀".repeat(470)} #a #b  `, format)).toEqual([
      FORMAT_LENGTH,
    ]);
    expect(formatProblems(`  ${"😀".repeat(280)} #a #b  `, format)).toEqual([]);
  });

  it("counts hashtags exactly", () => {
    expect(hashtagCount("Text #beta #teams, #web3_now.")).toBe(3);
    // Not hashtags: an HTML entity, a URL fragment, a word with a sign inside.
    expect(hashtagCount("A&#39;s https://x.example/#top C#sharp")).toBe(0);
    // A number is no hashtag.
    expect(hashtagCount("Since #2026 and #100_000, #web3 #2026beta")).toBe(2);
    expect(formatProblems(body(700, " #one"), format)).toEqual([
      FORMAT_HASHTAGS,
    ]);
    expect(formatProblems(body(700, " #a #b #c #d"), format)).toEqual([
      FORMAT_HASHTAGS,
    ]);
    expect(formatProblems(body(100, ""), format)).toEqual([
      FORMAT_LENGTH,
      FORMAT_HASHTAGS,
    ]);
  });

  it("checks nothing without a format", () => {
    expect(formatProblems("short", undefined)).toEqual([]);
    expect(formatProblems("short", null)).toEqual([]);
  });

  it("tells the copywriter what to change and to add no claim", () => {
    const text = formatInstruction(body(100, ""), format, [
      FORMAT_LENGTH,
      FORMAT_HASHTAGS,
    ]);
    expect(text).toContain("600 to 900 characters long (it has 100");
    expect(text).toContain("short paragraphs");
    expect(text).toContain("2 to 3 hashtags");
    expect(text).toContain("add no new claim");
    expect(
      formatInstruction(body(700, ""), format, [FORMAT_HASHTAGS]),
    ).not.toContain("characters long");
  });
});

describe("slot groups of a shared run (R76)", () => {
  const at = (hour: number) => `2026-10-13T${hour}:00:00.000Z`;
  const slots = [
    { channel: "x", at: at(10), groupAt: at(10) },
    { channel: "tg", at: at(10), groupAt: at(10) },
    // Moved half an hour at planning: still the 10:00 post.
    { channel: "li", at: "2026-10-13T10:30:00.000Z", groupAt: at(10) },
    { channel: "x", at: at(17), groupAt: at(17) },
    { channel: "tg", at: at(17), groupAt: at(17), releasedAt: at(9) },
  ];

  it("groups held slots by their requested time", () => {
    expect(
      slotGroups(slots).map((group) => [
        group.at,
        group.slots.map((slot) => slot.channel),
      ]),
    ).toEqual([
      [at(10), ["x", "tg", "li"]],
      [at(17), ["x"]],
    ]);
  });

  it("finds a slot's group, itself first", () => {
    expect(groupSlots(slots, "tg", at(10)).map((s) => s.channel)).toEqual([
      "tg",
      "x",
      "li",
    ]);
    expect(groupSlots(slots, "x", at(17)).map((s) => s.channel)).toEqual(["x"]);
    // A released or unknown slot has no group.
    expect(groupSlots(slots, "tg", at(17))).toEqual([]);
    // Slots without a recorded group are grouped by their own time.
    expect(
      groupSlots(
        [
          { channel: "x", at: at(10) },
          { channel: "tg", at: at(10) },
        ],
        "x",
        at(10),
      ).map((s) => s.channel),
    ).toEqual(["x", "tg"]);
  });

  it("prefers the slot at exactly that time over one moved from it", () => {
    const moved = [
      // X's 10:00 post moved to 10:30 for its veto window ...
      {
        channel: "x",
        at: "2026-10-13T10:30:00.000Z",
        requestedAt: at(10),
        groupAt: at(10),
      },
      // ... while X's 10:30 slot of another group was given that time.
      {
        channel: "x",
        at: at(10),
        groupAt: "2026-10-13T09:30:00.000Z",
      },
      { channel: "tg", at: at(10), groupAt: at(10) },
    ];
    expect(groupSlots(moved, "x", at(10))[0]).toBe(moved[1]);
    expect(
      groupSlots(moved, "x", "2026-10-13T10:30:00.000Z").map((s) => s.channel),
    ).toEqual(["x", "tg"]);
  });
});
