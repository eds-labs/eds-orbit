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
const refusal = (kind: "closed" | "failed") => createElement("p", { className: kind });

describe("redirectScreen", () => {
  it("renders the loading screen inside the pages' root wrapper while it waits or goes", () => {
    for (const kind of ["wait", "go"] as const) {
      const element = redirectScreen(kind, wrap, loading, refusal);
      expect(element?.type, kind).toBe(wrap(null).type);
      expect((element?.props as { children: ReactNode }).children, kind).toBe(loading);
    }
  });

  it("renders the refusal inside the same wrapper when the area is closed or failed", () => {
    for (const kind of ["closed", "failed"] as const) {
      const element = redirectScreen(kind, wrap, loading, refusal);
      expect(element?.type, kind).toBe(wrap(null).type);
      const child = (element?.props as { children: ReturnType<typeof refusal> }).children;
      expect(child, kind).toEqual(refusal(kind));
    }
  });

  it("renders nothing of its own for an address that is no old address", () => {
    expect(redirectScreen("none", wrap, loading, refusal)).toBeNull();
  });
});
