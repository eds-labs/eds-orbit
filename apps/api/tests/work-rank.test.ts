import { describe, expect, it } from "vitest";
import { isRank, rankBetween } from "../src/modules/work/rank.ts";

describe("fractional ranks (work board order)", () => {
  const sorted = (keys: string[]) =>
    [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  it("places keys between neighbours and at both ends", () => {
    const first = rankBetween(null, null);
    const after = rankBetween(first, null);
    const before = rankBetween(null, first);
    const middle = rankBetween(first, after);
    expect(sorted([after, middle, before, first])).toEqual([before, first, middle, after]);
    for (const key of [first, after, before, middle]) expect(isRank(key)).toBe(true);
  });

  it("keeps finding room after many inserts at the same place", () => {
    let low = rankBetween(null, null);
    const high = rankBetween(low, null);
    const keys = [low, high];
    for (let i = 0; i < 200; i++) {
      low = rankBetween(low, high);
      keys.push(low);
    }
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => k < high || k === high)).toBe(true);
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThan(60);
    let top = high;
    for (let i = 0; i < 200; i++) {
      const next = rankBetween(null, top);
      expect(next < top).toBe(true);
      top = next;
    }
  });

  it("refuses neighbours out of order and malformed keys", () => {
    expect(() => rankBetween("b", "a")).toThrow("WORK_RANK_ORDER");
    expect(() => rankBetween("a", "a")).toThrow("WORK_RANK_ORDER");
    expect(() => rankBetween("a0", null)).toThrow("WORK_RANK_INVALID");
    expect(() => rankBetween("a b", null)).toThrow("WORK_RANK_INVALID");
  });
});
