import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  focusReturn,
  initialFocusTarget,
  Sheet,
  sheetKeyAction,
} from "./sheet";

const focusable = (over: Record<string, unknown> = {}) => ({
  focus: vi.fn(),
  ...over,
});

describe("the sheet primitive (WP3.8)", () => {
  it("renders nothing while closed and a labelled non-modal dialog when open", () => {
    expect(
      renderToStaticMarkup(
        <Sheet open={false} onClose={() => {}} title="Orbit Assistant">
          body
        </Sheet>,
      ),
    ).toBe("");
    const html = renderToStaticMarkup(
      <Sheet
        open
        onClose={() => {}}
        title="Orbit Assistant"
        id="assistant-panel"
      >
        body
      </Sheet>,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="false"');
    expect(html).toContain('id="assistant-panel"');
    expect(html).toContain('tabindex="-1"');
    const labelled = /aria-labelledby="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`<h2 id="${labelled}">Orbit Assistant</h2>`);
  });

  it("closes on Escape only, never during composition or a handled key", () => {
    expect(sheetKeyAction({ key: "Escape" })).toBe("close");
    expect(sheetKeyAction({ key: "Escape", isComposing: true })).toBeNull();
    expect(
      sheetKeyAction({ key: "Escape", defaultPrevented: true }),
    ).toBeNull();
    expect(sheetKeyAction({ key: "Enter" })).toBeNull();
  });

  it("moves the focus to the composer, or the sheet while it is disabled", () => {
    const sheet = focusable();
    const composer = focusable();
    expect(initialFocusTarget(composer, sheet)).toBe(composer);
    expect(initialFocusTarget(focusable({ disabled: true }), sheet)).toBe(
      sheet,
    );
    expect(initialFocusTarget(null, sheet)).toBe(sheet);
  });

  it("returns the focus to the opener, or to the bubble when it is gone", () => {
    const opener = focusable({ isConnected: true });
    const bubble = focusable();
    focusReturn(opener, () => bubble)();
    expect(opener.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(bubble.focus).not.toHaveBeenCalled();
    const removed = focusable({ isConnected: false });
    focusReturn(removed, () => bubble)();
    expect(removed.focus).not.toHaveBeenCalled();
    expect(bubble.focus).toHaveBeenCalledTimes(1);
    focusReturn(null, () => bubble)();
    expect(bubble.focus).toHaveBeenCalledTimes(2);
  });
});
