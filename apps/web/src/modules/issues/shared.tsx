"use client";
import { useState } from "react";
import { useMutation, useResource } from "@/lib/api";
import { Alert, Badge, Button, Input, Modal, Textarea } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import {
  ISSUE_TYPES,
  issuesPath,
  send,
  SEVERITIES,
  type IntakeResult,
  type Issue,
  type IssuesSettings,
  type IssueStatus,
  type Member,
  type Severity,
} from "./api";
import { issuesText } from "./labels";

// Pieces every issue view shares: what the member may do, the project's
// components and members, badges, an issue row and the report form.

/**
 * What the member may do here. The module role the server advertises wins;
 * without it the project role decides. The server stays authoritative.
 */
export function useIssuesAccess() {
  const { isOwner, canEdit } = useWorkspace();
  const access = useShell().modules.find((m) => m.id === "issues")?.access;
  const owner = access ? access === "owner" : isOwner;
  const triage = access ? ["owner", "editor"].includes(access) : canEdit;
  return { owner, triage, report: triage };
}

export function useIssuesLists() {
  const { project } = useWorkspace();
  const settings = useResource<{ settings: IssuesSettings; version: number }>(issuesPath(project.id, "/settings"));
  const members = useResource<{ items: Member[] }>(issuesPath(project.id, "/members"));
  return {
    settings: settings.data?.settings ?? null,
    version: settings.data?.version ?? 1,
    members: members.data?.items ?? [],
    refresh: () => {
      settings.refresh();
      members.refresh();
    },
    loading: settings.loading || members.loading,
    error: settings.error ?? members.error,
  };
}

const STATUS_TONE: Record<IssueStatus, "neutral" | "blue" | "warning" | "success" | "danger"> = {
  new: "warning",
  triage: "warning",
  needs_info: "warning",
  confirmed: "blue",
  duplicate: "neutral",
  wont_fix: "neutral",
  planned: "blue",
  in_progress: "blue",
  fix_ready: "success",
  released: "success",
  verified: "success",
  closed: "neutral",
};
const SEVERITY_TONE: Record<Severity, "danger" | "warning" | "neutral"> = {
  s1_critical: "danger",
  s2_major: "warning",
  s3_minor: "neutral",
  s4_trivial: "neutral",
};

export function StatusBadge({ status }: { status: IssueStatus }) {
  const { locale } = useWorkspace();
  return <Badge tone={STATUS_TONE[status]}>{issuesText(locale).status[status]}</Badge>;
}

export function SeverityBadge({ severity }: { severity: Severity | null }) {
  const { locale } = useWorkspace();
  if (!severity) return null;
  return <Badge tone={SEVERITY_TONE[severity]}>{issuesText(locale).severity[severity]}</Badge>;
}

/** One issue as a list row; opens its detail. */
export function IssueRow({
  issue,
  counts,
  selected,
  onOpen,
}: {
  issue: Issue;
  counts?: { tasks: number; tickets: number; reports: number };
  selected?: boolean;
  onOpen?: (id: string) => void;
}) {
  const { locale } = useWorkspace();
  const shell = useShell();
  const t = issuesText(locale);
  const body = (
    <>
      <span className="support-row-title">
        {issue.key} {issue.title}
      </span>
      <span className="support-row-meta">
        {t.type[issue.type]}
        {` · ${t.reports} ${counts?.reports ?? issue.reportCount}`}
        {(counts?.tickets ?? issue.ticketCount) > 0 && ` · ${t.tickets} ${counts?.tickets ?? issue.ticketCount}`}
        {counts && counts.tasks > 0 && ` · ${t.tasks} ${counts.tasks}`}
      </span>
      <span className="support-row-badges">
        <StatusBadge status={issue.status} />
        <SeverityBadge severity={issue.severity} />
        {issue.components.map((c) => (
          <Badge key={c}>{c}</Badge>
        ))}
      </span>
    </>
  );
  return (
    <li>
      {onOpen ? (
        <button
          type="button"
          className={selected ? "support-row support-row-active" : "support-row"}
          aria-current={selected ? "true" : undefined}
          onClick={() => onOpen(issue.id)}
        >
          {body}
        </button>
      ) : (
        <AppLink className="support-row" href={`${shell.hrefOf("issues-list")}?issue=${encodeURIComponent(issue.id)}`}>
          {body}
        </AppLink>
      )}
    </li>
  );
}

/** A member's report: a new issue, or a report on `issueId`. */
export function ReportForm({
  issueId,
  onClose,
  onDone,
}: {
  issueId?: string;
  onClose: () => void;
  onDone: (result: IntakeResult) => void;
}) {
  const { project, locale } = useWorkspace();
  const t = issuesText(locale);
  const lists = useIssuesLists();
  const [form, setForm] = useState({ title: "", symptoms: "", type: "bug", severity: "", components: [] as string[] });
  const mutation = useMutation();
  return (
    <Modal title={t.newReport} onClose={onClose}>
      <form
        className="support-form work-stack"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.run(async () => {
            const path = issueId ? `/issues/${encodeURIComponent(issueId)}/reports` : "/issues";
            const result = await send<IntakeResult>(issuesPath(project.id, path), "POST", {
              title: form.title,
              ...(form.symptoms.trim() ? { symptoms: form.symptoms } : {}),
              type: form.type,
              ...(form.severity ? { severity: form.severity } : {}),
              components: form.components,
            });
            onDone(result);
          });
        }}
      >
        <p className="support-muted">{t.reportHint}</p>
        <label>
          {t.fields.title}
          <Input required maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus />
        </label>
        <label>
          {t.fields.symptoms}
          <Textarea rows={5} maxLength={4000} value={form.symptoms} onChange={(e) => setForm({ ...form, symptoms: e.target.value })} />
        </label>
        <div className="support-controls">
          <label>
            {t.fields.type}
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {ISSUE_TYPES.map((v) => (
                <option key={v} value={v}>
                  {t.type[v]}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t.fields.severity}
            <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
              <option value="">—</option>
              {SEVERITIES.map((v) => (
                <option key={v} value={v}>
                  {t.severity[v]}
                </option>
              ))}
            </select>
          </label>
          {(lists.settings?.components.length ?? 0) > 0 && (
            <label>
              {t.fields.components}
              <select
                multiple
                value={form.components}
                onChange={(e) => setForm({ ...form, components: [...e.target.selectedOptions].map((o) => o.value) })}
              >
                {lists.settings!.components.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label[locale]}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
        <div className="work-actions">
          <Button type="submit" disabled={mutation.pending || !form.title.trim()}>
            {t.create}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t.cancel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
