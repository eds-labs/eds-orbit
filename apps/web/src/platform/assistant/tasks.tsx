"use client";
import { useEffect, useState } from "react";
import { post, useResource } from "@/lib/api";
import { useWorkspace } from "@/components/workspace-context";
import { Alert, Badge, Button } from "@/components/ui/primitives";

type Task = {
  taskId: string;
  description: string;
  status: string;
  phase: string;
  conversationId: string;
  errorCode: string | null;
  approvals: Array<{ actionRequestId: string; status: string }>;
};
const terminal = new Set([
  "succeeded",
  "failed",
  "blocked",
  "canceled",
  "rejected",
  "expired",
]);
const statusText: Record<string, [string, string]> = {
  awaiting_approval: ["Needs approval", "Freigabe erforderlich"],
  queued: ["Queued", "Eingereiht"],
  running: ["Running", "Läuft"],
  succeeded: ["Completed", "Abgeschlossen"],
  failed: ["Failed", "Fehlgeschlagen"],
  blocked: ["Blocked", "Blockiert"],
  canceled: ["Canceled", "Abgebrochen"],
  rejected: ["Rejected", "Abgelehnt"],
  expired: ["Expired", "Abgelaufen"],
};

/** Compact work-order history beside the existing private assistant conversations. */
export function AssistantTasks({
  open,
}: {
  open: (conversationId: string) => void;
}) {
  const { project, locale } = useWorkspace();
  const de = locale === "de";
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const tasks = useResource<{ items: Task[]; nextCursor: string | null }>(
    `/projects/${project.id}/assistant-tasks?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
  const active = tasks.data?.items.some((t) => !terminal.has(t.status));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => tasks.refresh(), 5000);
    return () => clearInterval(timer);
  }, [active, tasks.refresh]);
  useEffect(() => setCursor(null), [project.id]);
  if (!tasks.data?.items.length && !cursor) return null;
  return (
    <section
      className="panel assistant-tasks"
      aria-label={de ? "Externe Aufträge" : "External work orders"}
    >
      <div className="panel-head">
        <h2>{de ? "Externe Aufträge" : "External work orders"}</h2>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {tasks.data?.items.map((task) => (
        <article key={task.taskId} className="assistant-task">
          <div className="chat-proposal-head">
            <strong>{task.description.slice(0, 160)}</strong>
            <Badge
              tone={
                task.status === "failed" || task.status === "blocked"
                  ? "warning"
                  : "blue"
              }
            >
              {
                (statusText[task.status] ?? [task.status, task.status])[
                  de ? 1 : 0
                ]
              }
            </Badge>
          </div>
          {task.errorCode && <p role="status">{task.errorCode}</p>}
          <div className="form-actions">
            <Button size="sm" onClick={() => open(task.conversationId)}>
              {de ? "Verlauf und Ergebnisse" : "Conversation and results"}
            </Button>
            {!terminal.has(task.status) && (
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  try {
                    await post(
                      `/projects/${project.id}/assistant-tasks/${task.taskId}/cancel`,
                      {},
                    );
                    tasks.refresh();
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
        </article>
      ))}
      <div className="form-actions">
        {cursor && (
          <Button size="sm" onClick={() => setCursor(null)}>
            {de ? "Neueste" : "Newest"}
          </Button>
        )}
        {tasks.data?.nextCursor && (
          <Button size="sm" onClick={() => setCursor(tasks.data!.nextCursor)}>
            {de ? "Weitere" : "More"}
          </Button>
        )}
      </div>
    </section>
  );
}
