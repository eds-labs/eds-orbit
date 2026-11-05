import { describe, expect, it } from "vitest";
import Page from "@/app/(shell)/[[...route]]/page";
import { shouldScrollToTop } from "./scroll-reset";

describe("navigation keeps the shell and starts pages at the top", () => {
  it("renders the shell from the layout, so navigating never remounts it", () => {
    // The sidebar's scroll position and the loaded identity survive a click
    // only while the page under [[...route]] (which remounts per path) is empty.
    expect(Page()).toBeNull();
  });

  it("scrolls a new page to the top, but not on the first load", () => {
    expect(shouldScrollToTop(null, "/p/1", false)).toBe(false);
    expect(shouldScrollToTop("/p/1", "/p/1/support", false)).toBe(true);
  });

  it("keeps the position for back/forward and an unchanged path", () => {
    expect(shouldScrollToTop("/p/1", "/p/1/support", true)).toBe(false);
    expect(shouldScrollToTop("/p/1/settings", "/p/1/settings", false)).toBe(
      false,
    );
  });
});
