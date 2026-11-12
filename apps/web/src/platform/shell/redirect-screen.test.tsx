import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { redirectScreen } from "./redirect-screen";

// The loading screen of a redirect renders inside the same root wrapper as
// the pages (the assistant provider in the shell), so the wrapper keeps its
// element type and position and is not remounted for that render.

function Root({ children }: { children: ReactNode }) {
  return children;
}
const wrap = (tree: ReactNode) => createElement(Root, null, tree);
const loading = createElement("div", { className: "boot" });

describe("redirectScreen", () => {
  it("renders the loading screen inside the pages' root wrapper while it waits or goes", () => {
    for (const kind of ["wait", "go"] as const) {
      const element = redirectScreen(kind, wrap, loading);
      expect(element?.type, kind).toBe(wrap(null).type);
      expect((element?.props as { children: ReactNode }).children, kind).toBe(loading);
    }
  });

  it("renders nothing of its own when the page stays", () => {
    expect(redirectScreen("stay", wrap, loading)).toBeNull();
  });
});
