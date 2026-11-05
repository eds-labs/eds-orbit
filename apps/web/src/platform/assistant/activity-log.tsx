"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ScrollText } from "lucide-react";
import { post, useResource, when } from "@/lib/api";
import { useWorkspace } from "@/components/workspace-context";
import { Alert, Badge, Button, Empty, Loading } from "@/components/ui/primitives";
import { PageHead } from "@/platform/ui/collection";
import { useShell } from "@/platform/shell/shell-context";

// The project's activity log: work orders that external AI clients (MCP 2.0)
// started for the member. It used to sit above Orbit Chat; each order still
// opens its private conversation there.

type WorkOrder = {
  taskId: string;
  description: string;
  status: string;
  conversationId: string;
  errorCode: string | null;
  modules?: string[];
  createdAt?: string;
  completedAt?: string | null;
};
type WorkOrderPage = { items: WorkOrder[]; nextCursor: string | null };

const STATUS: Record<
  string,
  { en: string; de: string; done: boolean; tone: "blue" | "warning" | "success" | "neutral" }
> = {
  awaiting_approval: { en: "Needs approval", de: "Freigabe erforderlich", done: false, tone: "warning" },
  queued: { en: "Queued", de: "Eingereiht", done: false, tone: "blue" },
  running: { en: "Running", de: "Läuft", done: false, tone: "blue" },
  succeeded: { en: "Completed", de: "Abgeschlossen", done: true, tone: "success" },
  failed: { en: "Failed", de: "Fehlgeschlagen", done: true, tone: "warning" },
  blocked: { en: "Blocked", de: "Blockiert", done: true, tone: "warning" },
  canceled: { en: "Canceled", de: "Abgebrochen", done: true, tone: "neutral" },
  rejected: { en: "Rejected", de: "Abgelehnt", done: true, tone: "neutral" },
  expired: { en: "Expired", de: "Abgelaufen", done: true, tone: "neutral" },
};

/** A work order's status as a label, whether it is finished and its badge tone. */
export function workOrderStatus(status: string, locale: string) {
  const known = STATUS[status];
  if (!known) return { label: status, done: false, tone: "neutral" as const };
  return {
    label: locale === "de" ? known.de : known.en,
    done: known.done,
    tone: known.tone,
  };
}

/** The activity log page: external work orders, newest first, with paging. */
export function ActivityLog() {
  const { project, locale } = useWorkspace();
  const de = locale === "de";
  const [pages, setPages] = useState<Array<string | null>>([null]);
  useEffect(() => setPages([null]), [project.id]);
  return (
    <div className="activity-log">
      <PageHead
        title={de ? "Aktivitätslog" : "Activity log"}
        description={
          de
            ? "Aufträge, die externe KI-Clients (zum Beispiel ChatGPT über MCP) in diesem Projekt für dich gestartet haben."
            : "Work orders that external AI clients (for example ChatGPT via MCP) started for you in this project."
        }
      />
      {pages.map((cursor, i) => (
        <WorkOrderList
          key={cursor ?? "first"}
          cursor={cursor}
          first={i === 0}
          onMore={
            i === pages.length - 1
              ? (next) => setPages([...pages, next])
              : undefined
          }
        />
      ))}
    </div>
  );
}

function WorkOrderList({
  cursor,
  first,
  onMore,
}: {
  cursor: string | null;
  first: boolean;
  onMore?: (cursor: string) => void;
}) {
  const { project, locale } = useWorkspace();
  const shell = useShell();
  const de = locale === "de";
  const [error, setError] = useState("");
  const page = useResource<WorkOrderPage>(
    `/projects/${project.id}/assistant-tasks?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
  const active = page.data?.items.some(
    (t) => !workOrderStatus(t.status, locale).done,
  );
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => page.refresh(), 5000);
    return () => clearInterval(timer);
  }, [active, page.refresh]);
  if (page.loading && !page.data)
    return <Loading label={de ? "Lädt…" : "Loading…"} />;
  if (page.error)
    return (
      <Alert kind="error">
        {de
          ? "Die Aufträge konnten nicht geladen werden."
          : "The work orders could not be loaded."}
      </Alert>
    );
  const items = page.data?.items ?? [];
  if (first && !items.length)
    return (
      <Empty
        icon={ScrollText}
        title={de ? "Noch keine externen Aufträge" : "No external work orders yet"}
        description={
          de
            ? "Startet ein verbundener KI-Client einen Auftrag, erscheint er hier mit Status und Verlauf."
            : "When a connected AI client starts a work order, it appears here with its status and conversation."
        }
      />
    );
  const chat = shell.hrefOf("chat");
  return (
    <>
      {error && <Alert kind="error">{error}</Alert>}
      <ul className="activity-list" aria-label={de ? "Externe Aufträge" : "External work orders"}>
        {items.map((task) => {
          const status = workOrderStatus(task.status, locale);
          return (
            <li key={task.taskId} className="activity-item">
              <div className="activity-item-head">
                <strong>{task.description.slice(0, 280)}</strong>
                <Badge tone={status.tone}>{status.label}</Badge>
              </div>
              <p className="activity-meta">
                {task.createdAt && (
                  <span>
                    {de ? "Gestartet " : "Started "}
                    {when(task.createdAt, locale, project.timezone)}
                  </span>
                )}
                {task.completedAt && (
                  <span>
                    {de ? "Beendet " : "Finished "}
                    {when(task.completedAt, locale, project.timezone)}
                  </span>
                )}
                {task.modules?.length ? <span>{task.modules.join(", ")}</span> : null}
              </p>
              {task.errorCode && (
                <p className="activity-error" role="status">
                  {task.errorCode}
                </p>
              )}
              <div className="form-actions">
                <Button asChild size="sm">
                  <Link
                    href={`${chat}?conversation=${encodeURIComponent(task.conversationId)}`}
                  >
                    {de ? "Verlauf und Ergebnisse" : "Conversation and results"}
                  </Link>
                </Button>
                {!status.done && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      try {
                        setError("");
                        await post(
                          `/projects/${project.id}/assistant-tasks/${task.taskId}/cancel`,
                          {},
                        );
                        page.refresh();
                      } catch {
                        setError(
                          de
                            ? "Auftrag konnte nicht abgebrochen werden."
                            : "Could not cancel the work order.",
                        );
                      }
                    }}
                  >
                    {de ? "Abbrechen" : "Cancel"}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {onMore && page.data?.nextCursor && (
        <div className="form-actions activity-more">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onMore(page.data!.nextCursor!)}
          >
            {de ? "Ältere laden" : "Load older"}
          </Button>
        </div>
      )}
    </>
  );
}
