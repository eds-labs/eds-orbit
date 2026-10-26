"use client";
import { useEffect, useState } from "react";
import { Bug } from "lucide-react";
import { useMutation, useResource } from "@/lib/api";
import { Alert, Badge, Button, Input, Modal, Textarea } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import { post, supportPath, type TimelineEntry } from "./api";

// A ticket reported as a product issue (ADR 0018): the agent writes or
// confirms the text, sees what is removed before anything leaves the
// ticket, and acknowledges sensitive topics. The issues the ticket was
// reported in show as chips; members who may not read issues see a
// restricted placeholder. Shown only while the Issues module is on.

type LinkedIssue = {
  id: string;
  object: { id: string; state: "ok" | "restricted" | "missing"; title?: string; status?: string; href?: string };
};

const TEXT = {
  en: {
    report: "Report as product issue",
    title: "Title",
    symptoms: "What happens (customer identity removed)",
    preview: "Take over the customer's messages",
    removed: (n: number) => `${n} sensitive ${n === 1 ? "value" : "values"} removed`,
    sensitive: "This ticket touches a sensitive topic. I checked that the text contains nothing that should stay in Support.",
    send: "Report",
    cancel: "Cancel",
    reported: "Reported as an issue.",
    issues: "Issues",
    restricted: "Issue (restricted)",
  },
  de: {
    report: "Als Produkt-Issue melden",
    title: "Titel",
    symptoms: "Was passiert (ohne Kundenidentität)",
    preview: "Nachrichten der Kundin oder des Kunden übernehmen",
    removed: (n: number) => `${n} ${n === 1 ? "sensibler Wert" : "sensible Werte"} entfernt`,
    sensitive: "Dieses Ticket berührt ein sensibles Thema. Ich habe geprüft, dass der Text nichts enthält, was im Support bleiben muss.",
    send: "Melden",
    cancel: "Abbrechen",
    reported: "Als Issue gemeldet.",
    issues: "Issues",
    restricted: "Issue (eingeschränkt)",
  },
};

/** True while the Issues module is shown in this project. */
function useIssuesOn() {
  return useShell().modules.some((m) => m.id === "issues" && m.enabled && m.access !== "none");
}

export function TicketIssues({ ticketId }: { ticketId: string }) {
  const { project, locale } = useWorkspace();
  const on = useIssuesOn();
  const t = TEXT[locale];
  const issues = useResource<{ items: LinkedIssue[] }>(on ? supportPath(project.id, `/tickets/${ticketId}/issues`) : null);
  const items = issues.data?.items ?? [];
  if (!on || !items.length) return null;
  return (
    <div className="support-badges" aria-label={t.issues}>
      {items.map((l) =>
        l.object.state === "ok" && l.object.href ? (
          <AppLink key={l.id} href={l.object.href}>
            <Badge tone="blue">
              {l.object.title}
              {l.object.status ? ` · ${l.object.status}` : ""}
            </Badge>
          </AppLink>
        ) : (
          <Badge key={l.id}>{t.restricted}</Badge>
        ),
      )}
    </div>
  );
}

export function ReportIssueButton({
  ticketId,
  subject,
  entries,
  onReported,
}: {
  ticketId: string;
  subject: string;
  entries: TimelineEntry[];
  onReported: () => void;
}) {
  const { project, locale } = useWorkspace();
  const on = useIssuesOn();
  const t = TEXT[locale];
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: subject.slice(0, 200), symptoms: "", acknowledge: false });
  const [preview, setPreview] = useState<{ removed: number; sensitive: string[] } | null>(null);
  const mutation = useMutation();
  const customer = entries.filter((e) => e.entry === "message" && e.kind === "customer").map((e) => e.id).slice(-20);
  useEffect(() => setForm((f) => ({ ...f, title: subject.slice(0, 200) })), [subject]);
  if (!on) return null;
  return (
    <>
      <Button size="sm" variant="outline" type="button" onClick={() => setOpen(true)}>
        <Bug aria-hidden /> {t.report}
      </Button>
      {mutation.success && <Alert kind="info">{t.reported}</Alert>}
      {open && (
        <Modal title={t.report} onClose={() => setOpen(false)}>
          <form
            className="support-form"
            onSubmit={(e) => {
              e.preventDefault();
              mutation.run(async () => {
                await post(supportPath(project.id, `/tickets/${ticketId}/issue-report`), {
                  title: form.title,
                  ...(form.symptoms.trim() ? { symptoms: form.symptoms } : {}),
                  acknowledgeSensitive: form.acknowledge,
                });
                setOpen(false);
                onReported();
              });
            }}
          >
            <label>
              {t.title}
              <Input required maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </label>
            <label>
              {t.symptoms}
              <Textarea rows={6} maxLength={4000} value={form.symptoms} onChange={(e) => setForm({ ...form, symptoms: e.target.value })} />
            </label>
            {customer.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={mutation.pending}
                onClick={() =>
                  mutation.run(async () => {
                    const result = await post<{ symptoms: string; redaction: Record<string, number>; sensitive: string[] }>(
                      supportPath(project.id, `/tickets/${ticketId}/issue-report/preview`),
                      { messageIds: customer },
                    );
                    setForm((f) => ({ ...f, symptoms: result.symptoms }));
                    setPreview({ removed: Object.values(result.redaction).reduce((a, n) => a + n, 0), sensitive: result.sensitive });
                  })
                }
              >
                {t.preview}
              </Button>
            )}
            {preview && preview.removed > 0 && <Badge tone="warning">{t.removed(preview.removed)}</Badge>}
            {(preview?.sensitive.length ?? 0) > 0 || mutation.error?.includes("SENSITIVE") ? (
              <label className="support-check">
                <input type="checkbox" checked={form.acknowledge} onChange={(e) => setForm({ ...form, acknowledge: e.target.checked })} />
                {t.sensitive}
              </label>
            ) : null}
            {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
            <div className="form-actions">
              <Button type="submit" disabled={mutation.pending || !form.title.trim()}>
                {t.send}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                {t.cancel}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
