"use client";
import { useEffect, useState } from "react";
import { useResource } from "@/lib/api";
import { withWorkspace } from "./api";

// The cross-project inbox (ADR 0023, plan WP4.3): unread counts and the
// newest notices across the member's projects, for the bell's "All
// projects" tab and the assistant bubble's badge. It waits on the
// content-free wake-up stream while the server offers it and polls once a
// minute otherwise (no personal space yet, Redis down, stream closed).
// Hidden while the feature is off (404).

export type SummaryItem = {
  id: string;
  projectId: string;
  projectName: string;
  /** The user's personal space (assistant notices). */
  personal: boolean;
  moduleId: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  severity: "info" | "attention" | "urgent";
  occurrences: number;
  readAt: string | null;
  createdAt: string;
  lastOccurredAt: string;
};

export type NotificationSummary = {
  unread: number;
  projects: Array<{ projectId: string; projectName: string; personal: boolean; unread: number }>;
  items: SummaryItem[];
  personalSpaceId: string | null;
  realtime: boolean;
};

export const SUMMARY_POLL_MS = 60_000;

export const summaryPath = (workspaceId?: string) =>
  withWorkspace("/notifications/summary", workspaceId);
export const summaryStreamPath = (workspaceId?: string) =>
  withWorkspace("/api/notifications/stream", workspaceId);

/** Whether the client should wait on the stream rather than poll. */
export function streamWanted(summary: Pick<NotificationSummary, "realtime"> | null) {
  return Boolean(summary?.realtime) && typeof EventSource !== "undefined";
}

export function useNotificationSummary(workspaceId: string | undefined, active = true) {
  const resource = useResource<NotificationSummary>(active ? summaryPath(workspaceId) : null);
  const { refresh } = resource;
  const [streaming, setStreaming] = useState(false);
  // A reload clears `data` until it answers; keep the last summary meanwhile
  // so the badge, the tab and the stream do not flicker every minute.
  const [last, setLast] = useState<NotificationSummary | null>(null);
  useEffect(() => {
    if (resource.data) setLast(resource.data);
  }, [resource.data]);
  const current = resource.data ?? last;
  const wantsStream = streamWanted(current);
  // Polling: always while no stream is open, once a minute.
  useEffect(() => {
    if (!active || streaming) return;
    const timer = setInterval(refresh, SUMMARY_POLL_MS);
    return () => clearInterval(timer);
  }, [active, streaming, refresh]);
  // The wake-up stream: every "changed" event reads the summary again; an
  // error closes it and polling takes over.
  useEffect(() => {
    if (!active || !wantsStream) return;
    const source = new EventSource(summaryStreamPath(workspaceId));
    let first = true;
    source.addEventListener("changed", () => {
      setStreaming(true);
      // The first event only confirms the connection.
      if (first) first = false;
      else refresh();
    });
    source.onerror = () => {
      source.close();
      setStreaming(false);
    };
    return () => {
      source.close();
      setStreaming(false);
    };
  }, [active, wantsStream, workspaceId, refresh]);
  const off = resource.error?.status === 404;
  return { ...resource, data: off ? null : current, off, streaming };
}

/** The bubble's badge: "9+" above nine, nothing at zero. */
export function badgeLabel(unread: number) {
  return unread <= 0 ? "" : unread > 9 ? "9+" : String(unread);
}
