import { beforeEach, describe, expect, it, vi } from "vitest";

// A plain function (not vi.fn): vitest fails a test whose mock threw.
let respond: (path: string) => Promise<unknown> = async () => undefined;
const calls: string[] = [];
const api = {
  mockReset: () => {
    calls.length = 0;
    respond = async () => undefined;
  },
  mockResolvedValue: (value: unknown) => {
    respond = async () => value;
  },
  mockRejected: () => {
    respond = async () => {
      throw new Error("down");
    };
  },
};
vi.mock("@/lib/api", () => ({
  MutationCanceled: class MutationCanceled extends Error {},
  api: (path: string) => {
    calls.push(path);
    return respond(path);
  },
}));

import {
  confirmReleaseImpact,
  formatReleaseSlot,
  releaseImpactText,
} from "./release-impact";

const dependent = {
  id: "p1",
  title: "Launch",
  slotAt: "2026-11-18T17:30:00Z",
  timeZone: "Europe/Berlin",
  channels: ["FamilyPlan Facebook"],
};
const impact = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  gateValid: true,
  count: 1,
  dependents: [dependent],
  ...over,
});

beforeEach(() => api.mockReset());

describe("confirmReleaseImpact", () => {
  it("does not ask when nothing depends on the gate", async () => {
    api.mockResolvedValue(impact({ count: 0, dependents: [] }));
    const ask = vi.fn((_text: string) => false);
    expect(await confirmReleaseImpact("proj", "de", ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
  it("does not ask when the gate is already invalid or the feature is off", async () => {
    const ask = vi.fn((_text: string) => false);
    api.mockResolvedValue(impact({ gateValid: false }));
    expect(await confirmReleaseImpact("proj", "de", ask)).toBe(true);
    api.mockResolvedValue(impact({ enabled: false }));
    expect(await confirmReleaseImpact("proj", "de", ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
  it("asks with the posts named and returns the answer", async () => {
    api.mockResolvedValue(impact());
    const ask = vi.fn((_text: string) => false);
    expect(await confirmReleaseImpact("proj", "de", ask)).toBe(false);
    expect(calls).toEqual(["/projects/proj/knowledge/release-impact"]);
    expect(ask.mock.calls[0]![0]).toContain("18:30");
    expect(ask.mock.calls[0]![0]).toContain("FamilyPlan Facebook");
  });
  it("returns true when the person confirms", async () => {
    api.mockResolvedValue(impact());
    expect(await confirmReleaseImpact("proj", "en", () => true)).toBe(true);
  });
  it("asks with a count when details are withheld", async () => {
    api.mockResolvedValue(impact({ count: 2, dependents: [] }));
    const ask = vi.fn((_text: string) => true);
    await confirmReleaseImpact("proj", "de", ask);
    expect(ask.mock.calls[0]![0]).toContain("2 freigegebene Marketing-Posts");
  });
  it("does not block the action when the check fails", async () => {
    api.mockRejected();
    const ask = vi.fn((_text: string) => false);
    expect(await confirmReleaseImpact("proj", "en", ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("releaseImpactText", () => {
  it("names the posts in English and caps the list at three", () => {
    const many = impact({
      count: 5,
      dependents: Array.from({ length: 5 }, (_, i) => ({
        ...dependent,
        id: `p${i}`,
      })),
    });
    const text = releaseImpactText(
      many as never,
      "en",
      new Date("2026-11-18T08:00:00Z"),
    );
    expect(text).toContain("5 released posts");
    expect(text).toContain("today 18:30 · FamilyPlan Facebook");
    expect(text).toContain("+2");
    expect(text.match(/FamilyPlan Facebook/g)).toHaveLength(3);
  });
  it.each([
    [
      "de",
      1,
      "Diese Änderung kann 1 freigegebenen Post (",
      "Diese Änderung kann 1 freigegebenen Marketing-Post betreffen.",
    ],
    [
      "de",
      2,
      "Diese Änderung kann 2 freigegebene Posts (",
      "Diese Änderung kann 2 freigegebene Marketing-Posts betreffen.",
    ],
    [
      "en",
      1,
      "This change can affect 1 released post (",
      "This change can affect 1 released marketing post.",
    ],
    [
      "en",
      2,
      "This change can affect 2 released posts (",
      "This change can affect 2 released marketing posts.",
    ],
  ])(
    "uses the right noun form in %s for %i post(s)",
    (locale, count, named, counted) => {
      const dependents = Array.from({ length: count }, (_, i) => ({
        ...dependent,
        id: `p${i}`,
      }));
      expect(
        releaseImpactText(impact({ count, dependents }) as never, locale),
      ).toContain(named);
      expect(
        releaseImpactText(impact({ count, dependents: [] }) as never, locale),
      ).toContain(counted);
    },
  );
  it("falls back to the title and maps other locales to English", () => {
    const text = releaseImpactText(
      impact({ dependents: [{ ...dependent, channels: [] }] }) as never,
      "fr" as never,
    );
    expect(text).toContain("Launch");
    expect(text).toContain("released post");
  });
});

describe("formatReleaseSlot", () => {
  const now = new Date("2026-11-18T08:00:00Z");
  it("uses the dependent's time zone and today/tomorrow words", () => {
    expect(
      formatReleaseSlot("2026-11-18T17:30:00Z", "Europe/Berlin", "de", now),
    ).toBe("heute 18:30");
    expect(
      formatReleaseSlot("2026-11-19T17:30:00Z", "Europe/Berlin", "en", now),
    ).toBe("tomorrow 18:30");
    expect(
      formatReleaseSlot("2026-11-18T23:30:00Z", "Europe/Berlin", "en", now),
    ).toBe("tomorrow 00:30");
  });
  it("uses a short date otherwise", () => {
    expect(
      formatReleaseSlot("2026-11-25T17:30:00Z", "Europe/Berlin", "de", now),
    ).toMatch(/25\.\s?11\..*18:30/);
  });
});
