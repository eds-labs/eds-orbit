import { describe, expect, it } from "vitest";
import { keep, listPagesKey } from "./keep";

// The calendar after a move (P3): the grid keeps showing the last data
// while the same range reloads, and the list starts again.

describe("calendar refresh", () => {
  it("keeps the last data while the same path reloads, never for another path", () => {
    const first = keep({ path: null, data: null }, "/a", { n: 1 });
    expect(first).toEqual({ path: "/a", data: { n: 1 } });
    // Reloading the same path: the data is null for a moment, the grid stays.
    expect(keep(first, "/a", null)).toBe(first);
    expect(keep(first, "/a", { n: 2 })).toEqual({ path: "/a", data: { n: 2 } });
    // Another period or filter: nothing old is shown.
    expect(keep(first, "/b", null)).toEqual({ path: "/b", data: null });
  });

  it("gives the list a new key after a move", () => {
    expect(listPagesKey("view=list", 0)).not.toBe(listPagesKey("view=list", 1));
    expect(listPagesKey("view=list", 1)).toBe(listPagesKey("view=list", 1));
  });
});
