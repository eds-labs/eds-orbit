"use client";
import { useEffect, useRef } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/primitives";

// The list/detail pages (review, bookings, invoices) follow Support's
// pattern: on narrow screens an open detail replaces the list (CSS
// `.finance-review-open`), with a back control, and focus moves to the
// detail's heading when it opens.

/** "Back to the list"; only shown on narrow screens (globals.css). */
export function DetailBack({
  label,
  onBack,
}: {
  label: string;
  onBack: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="finance-back"
      onClick={onBack}
    >
      <ArrowLeft aria-hidden size={14} /> {label}
    </Button>
  );
}

/**
 * A ref for the detail's heading (rendered with tabIndex -1): it takes the
 * focus once, as soon as the heading exists, not again on a refetch.
 */
export function useDetailFocus<T extends HTMLElement = HTMLHeadingElement>(
  ready: boolean,
) {
  const ref = useRef<T>(null);
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current || !ref.current) return;
    done.current = true;
    ref.current.focus();
  }, [ready]);
  return ref;
}
