"use client";
import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";

// A non-modal side panel (WP3.8): a 420 px panel on the right on desktop,
// where the page stays usable, and a full-height sheet above the mobile
// bottom bar on phones. Focus moves into it on open and back to where it came
// from on close; Escape closes it. On phones the sheet covers the page, so Tab
// stays inside it there; on desktop it does not trap focus.

type Focusable = { focus(options?: FocusOptions): void };

/** The key's effect inside an open sheet. */
export function sheetKeyAction(event: {
  key: string;
  defaultPrevented?: boolean;
  isComposing?: boolean;
}): "close" | null {
  if (event.defaultPrevented || event.isComposing) return null;
  return event.key === "Escape" ? "close" : null;
}

/**
 * Remembers what had the focus when the sheet opened and gives it back on
 * close, or to the fallback (the bubble) when it is gone.
 */
export function focusReturn(
  previous: (Focusable & { isConnected?: boolean }) | null,
  fallback: () => Focusable | null | undefined,
) {
  return () => {
    const target =
      previous && previous.isConnected !== false ? previous : fallback();
    target?.focus({ preventScroll: true });
  };
}

/**
 * The element to focus on open: the requested one unless it is disabled (a
 * composer while a reply runs), else the sheet itself.
 */
export function initialFocusTarget<
  T extends Focusable & { disabled?: boolean },
>(requested: T | null | undefined, sheet: T | null | undefined): T | null {
  return requested && !requested.disabled ? requested : (sheet ?? null);
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Sheet({
  open,
  onClose,
  title,
  header,
  children,
  initialFocus,
  returnFocus,
  className,
  id,
}: {
  open: boolean;
  onClose: () => void;
  /** The accessible name; shown as the heading. */
  title: string;
  /** Controls beside the heading (the close button is the caller's). */
  header?: ReactNode;
  children: ReactNode;
  /** Focused on open, such as the composer (a ref or an element id); else the sheet. */
  initialFocus?: RefObject<HTMLElement | null> | string;
  /** Focused on close when the opener is gone, such as the bubble. */
  returnFocus?: RefObject<HTMLElement | null>;
  className?: string;
  id?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const headingId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const restore = focusReturn(
      document.activeElement instanceof HTMLElement &&
        document.activeElement !== document.body
        ? document.activeElement
        : null,
      () => returnFocus?.current,
    );
    // After paint, so a composer that renders with the sheet exists.
    const frame = requestAnimationFrame(() => {
      const requested =
        typeof initialFocus === "string"
          ? document.getElementById(initialFocus)
          : initialFocus?.current;
      initialFocusTarget(
        requested as (HTMLElement & { disabled?: boolean }) | null | undefined,
        ref.current,
      )?.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      // Only when the focus is still inside (or lost): a click elsewhere on
      // the page keeps its focus.
      const active = document.activeElement;
      if (!active || active === document.body || ref.current?.contains(active))
        restore();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // Escape also closes the sheet when the focus got lost (a control inside
  // was disabled or removed, so the page body has it); never while the
  // focus is on another part of the page.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (sheetKeyAction(event) !== "close") return;
      const active = document.activeElement;
      if (active && active !== document.body) return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  return (
    <section
      ref={ref}
      id={id}
      className={cn("sheet", className)}
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (sheetKeyAction(event.nativeEvent) === "close") {
          event.stopPropagation();
          onCloseRef.current();
          return;
        }
        if (
          event.key !== "Tab" ||
          !window.matchMedia("(max-width: 760px)").matches
        )
          return;
        const nodes = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
        );
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <header className="sheet-head">
        <h2 id={headingId}>{title}</h2>
        {header}
      </header>
      <div className="sheet-body">{children}</div>
    </section>
  );
}
