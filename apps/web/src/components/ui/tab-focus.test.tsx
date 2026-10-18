import { afterEach, describe, expect, it } from "vitest";
import {
  forgetTabFocus,
  rememberTabFocus,
  tabBarId,
  takeTabFocus,
} from "./tab-focus";

const knowledge = tabBarId(["overview", "sources", "impact"]);
const support = tabBarId(["reply", "note"]);

afterEach(() => {
  forgetTabFocus(knowledge);
  forgetTabFocus(support);
});

describe("tab focus across a remount", () => {
  it("restores the tab the user moved to once, in the remounted bar", () => {
    rememberTabFocus(knowledge, "impact");
    expect(takeTabFocus(knowledge, "impact")).toBe(true);
    expect(takeTabFocus(knowledge, "impact")).toBe(false);
  });

  it("restores nothing when no tab change happened", () => {
    expect(takeTabFocus(knowledge, "impact")).toBe(false);
  });

  it("is consumed by a mount of the same bar with another tab active", () => {
    rememberTabFocus(knowledge, "impact");
    expect(takeTabFocus(knowledge, "sources")).toBe(false);
    expect(takeTabFocus(knowledge, "impact")).toBe(false);
  });

  it("is never taken by another tab bar", () => {
    rememberTabFocus(knowledge, "impact");
    expect(takeTabFocus(support, "impact")).toBe(false);
    expect(takeTabFocus(knowledge, "impact")).toBe(true);
  });

  it("is dropped when the bar changed tabs in place", () => {
    rememberTabFocus(support, "note");
    forgetTabFocus(support);
    expect(takeTabFocus(support, "note")).toBe(false);
  });

  it("tells bars apart by their tab keys", () => {
    expect(tabBarId(["a", "b"])).toBe(tabBarId(["a", "b"]));
    expect(tabBarId(["a", "b"])).not.toBe(tabBarId(["a,b"]));
  });
});
