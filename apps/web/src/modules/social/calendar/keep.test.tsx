import { describe, expect, it } from "vitest";
import { keep, listPagesKey } from "./keep";

// The calendar after a move (P3): the grid keeps showing the last data
// while the same range reloads, and the list starts again.

describe("calendar refresh", () => {
  it("keeps the last data while the same path reloads, never for another path", () => {
    const first = keep({ path: null, data: null }, "/a", { n: 1 }, "/a");
    expect(first).toEqual({ path: "/a", data: { n: 1 } });
    // Reloading the same path: the data is null for a moment, the grid stays.
    expect(keep(first, "/a", null, "/a")).toBe(first);
    expect(keep(first, "/a", { n: 2 }, "/a")).toEqual({ path: "/a", data: { n: 2 } });
    // Another period or filter: nothing old is shown.
    expect(keep(first, "/b", null, "/a")).toEqual({ path: "/b", data: null });
  });

  it("never shows another path's data, even while the hook still holds it", () => {
    // useResource answers with the old data on the first render of a new path
    // (its effect clears it afterwards): only data loaded for the path counts.
    const first = keep({ path: null, data: null }, "/a", { n: 1 }, "/a");
    expect(keep(first, "/b", { n: 1 }, "/a")).toEqual({ path: "/b", data: null });
    const changed = keep(first, "/b", { n: 1 }, "/a");
    expect(keep(changed, "/b", null, "/a")).toEqual({ path: "/b", data: null });
    expect(keep(changed, "/b", { n: 3 }, "/b")).toEqual({ path: "/b", data: { n: 3 } });
    // Month to list: the list has no calendar path and shows no month data.
    expect(keep(first, null, { n: 1 }, "/a")).toEqual({ path: null, data: null });
  });

  it("gives the list a new key after a move", () => {
    expect(listPagesKey("view=list", 0)).not.toBe(listPagesKey("view=list", 1));
    expect(listPagesKey("view=list", 1)).toBe(listPagesKey("view=list", 1));
  });
});
