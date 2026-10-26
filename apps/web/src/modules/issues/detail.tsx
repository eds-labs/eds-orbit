"use client";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { api, useMutation, useResource } from "@/lib/api";
import { Alert, Badge, Button, Empty, Input, Loading, Modal } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import { ResourceError } from "@/platform/ui/collection";
import {
  ISSUE_TYPES,
  issuesPath,
  PRIORITIES,
  send,
  SEVERITIES,
  TRANSITIONS,
  when,
  type Delivery,
  type IssueDetail,
  type IssuePage,
} from "./api";
import { issuesText, type IssuesText } from "./labels";
import { SeverityBadge, StatusBadge, useIssuesAccess, useIssuesLists } from "./shared";

// One issue (plan §5): fields and status for triagers, the AI suggestion,
// redacted reports, duplicate candidates, linked tasks and tickets
// (restricted where the member may not see them), deliveries, the coding
// share review and the history.

export function IssueDetailView({
  issueId,
  onBack,
  onChanged,
  onOpen,
}: {
  issueId: string;
  onBack: () => void;
  onChanged: () => void;
  onOpen: (id: string) => void;
}) {
  const { project, locale } = useWorkspace();
  const t = issuesText(locale);
  const access = useIssuesAccess();
  const lists = useIssuesLists();
  const detail = useResource<IssueDetail>(issuesPath(project.id, `/issues/${encodeURIComponent(issueId)}`));
  const changed = () => {
    detail.refresh();
    onChanged();
  };
  const mutation = useMutation(changed);
  const [merging, setMerging] = useState(false);
  const [recording, setRecording] = useState(false);
  if (detail.loading && !detail.data) return <Loading />;
  if (detail.error) return <ResourceError error={detail.error} retry={detail.refresh} />;
  const d = detail.data!;
  const issue = d.issue;
  const base = issuesPath(project.id, `/issues/${encodeURIComponent(issue.id)}`);
  const patch = (fields: Record<string, unknown>) =>
    mutation.run(() => send(base, "PATCH", { expectedVersion: issue.version, ...fields }));
  const ai = issue.aiTriage.suggestion;
  const tasks = d.links.filter((l) => l.relation === "implements" && l.object.type === "work.task");
  const tickets = d.links.filter((l) => l.relation === "reported_in");
  const others = d.links.filter((l) => !tasks.includes(l) && !tickets.includes(l));
  const unconfirmed = ["new", "triage", "needs_info"].includes(issue.status);
  return (
    <article className="work-stack" aria-labelledby="issue-title">
      <div className="panel-head">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft aria-hidden /> {t.back}
        </Button>
      </div>
      <header className="work-stack">
        <h2 id="issue-title">
          {issue.key} {issue.title}
        </h2>
        <div className="support-row-badges">
          <StatusBadge status={issue.status} />
          <SeverityBadge severity={issue.severity} />
          <Badge>{t.type[issue.type]}</Badge>
          <Badge>
            {t.reports} {issue.reportCount}
          </Badge>
          {issue.ticketCount > 0 && (
            <Badge>
              {t.tickets} {issue.ticketCount}
            </Badge>
          )}
        </div>
        {issue.summary && <p style={{ whiteSpace: "pre-wrap" }}>{issue.summary}</p>}
        {issue.mergedIntoIssueId && (
          <Button variant="outline" size="sm" onClick={() => onOpen(issue.mergedIntoIssueId!)}>
            {t.status.duplicate} →
          </Button>
        )}
      </header>
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}

      {access.triage && issue.status !== "duplicate" && (
        <section className="panel work-stack" aria-label={t.fields.status}>
          <div className="support-controls">
            <label>
              {t.fields.status}
              <select
                value=""
                onChange={(e) =>
                  e.target.value &&
                  mutation.run(() => send(`${base}/status`, "POST", { status: e.target.value, expectedVersion: issue.version }))
                }
              >
                <option value="">{t.status[issue.status]}</option>
                {TRANSITIONS[issue.status].map((s) => (
                  <option key={s} value={s}>
                    → {t.status[s]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t.fields.severity}
              <select value={issue.severity ?? ""} onChange={(e) => patch({ severity: e.target.value || null })}>
                <option value="">—</option>
                {SEVERITIES.map((v) => (
                  <option key={v} value={v}>
                    {t.severity[v]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t.fields.priority}
              <select value={issue.priority ?? ""} onChange={(e) => patch({ priority: e.target.value || null })}>
                <option value="">—</option>
                {PRIORITIES.map((v) => (
                  <option key={v} value={v}>
                    {t.priority[v]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t.fields.type}
              <select value={issue.type} onChange={(e) => patch({ type: e.target.value })}>
                {ISSUE_TYPES.map((v) => (
                  <option key={v} value={v}>
                    {t.type[v]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t.fields.assignee}
              <select value={issue.assigneeUserId ?? ""} onChange={(e) => patch({ assigneeUserId: e.target.value || null })}>
                <option value="">—</option>
                {lists.members
                  .filter((m) => m.role !== "viewer")
                  .map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </label>
            {(lists.settings?.components.length ?? 0) > 0 && (
              <label>
                {t.fields.components}
                <select
                  multiple
                  value={issue.components}
                  onChange={(e) => patch({ components: [...e.target.selectedOptions].map((o) => o.value) })}
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
          <label className="support-check">
            <input
              type="checkbox"
              checked={issue.shareReviewed}
              onChange={(e) => mutation.run(() => send(`${base}/share-review`, "POST", { reviewed: e.target.checked, expectedVersion: issue.version }))}
            />
            {t.shareReview}
          </label>
          <p className="support-muted">{t.shareReviewHint}</p>
          <div className="work-actions">
            <Button variant="outline" size="sm" onClick={() => setMerging(true)}>
              {t.merge}
            </Button>
            <Button variant="outline" size="sm" disabled={mutation.pending} onClick={() => mutation.run(() => send(`${base}/triage`, "POST", {}))}>
              {t.ai.ask}
            </Button>
          </div>
        </section>
      )}

      {ai && <AiSuggestion t={t} issueVersion={issue.version} forVersion={issue.aiTriage.forVersion} suggestion={ai} base={base} canApply={access.triage} onDone={changed} />}

      <section className="panel work-stack" aria-labelledby="issue-tasks">
        <div className="panel-head">
          <h3 id="issue-tasks">{t.tasks}</h3>
          {tasks.length > 0 && <span className="support-muted">{t.progress(d.progress.done, d.progress.tasks)}</span>}
        </div>
        <LinkList t={t} links={tasks} />
        {access.triage && issue.status !== "duplicate" && (
          <div className="work-actions">
            <Button size="sm" disabled={unconfirmed || mutation.pending} onClick={() => mutation.run(() => send(`${base}/tasks`, "POST", {}))}>
              {t.createTask}
            </Button>
            <LinkTask t={t} base={base} onLinked={changed} />
          </div>
        )}
        {access.triage && unconfirmed && <p className="support-muted">{t.confirmFirst}</p>}
      </section>

      {(tickets.length > 0 || others.length > 0) && (
        <section className="panel work-stack" aria-labelledby="issue-links">
          <h3 id="issue-links">{t.links}</h3>
          <LinkList t={t} links={[...tickets, ...others]} />
        </section>
      )}

      <section className="panel work-stack" aria-labelledby="issue-duplicates">
        <h3 id="issue-duplicates">{t.duplicates}</h3>
        {!d.duplicateCandidates.length ? (
          <Empty title={t.noDuplicates} />
        ) : (
          <ul className="support-rows">
            {d.duplicateCandidates.map((c) => (
              <li key={c.id} className="work-stack">
                {c.issue && (
                  <button type="button" className="support-row" onClick={() => onOpen(c.issue!.id)}>
                    <span className="support-row-title">
                      {c.issue.key} {c.issue.title}
                    </span>
                    <span className="support-row-meta">
                      {t.score} {c.score.toFixed(2)} · {c.reasons.map((r) => t.reasons[r] ?? r).join(", ")}
                    </span>
                  </button>
                )}
                {access.triage && c.issue && (
                  <div className="work-actions">
                    <Button
                      size="sm"
                      disabled={mutation.pending}
                      onClick={() =>
                        mutation.run(() =>
                          send(issuesPath(project.id, `/issues/${encodeURIComponent(issue.id)}/merge`), "POST", {
                            targetIssueId: c.issue!.id,
                            expectedVersion: issue.version,
                          }),
                        )
                      }
                    >
                      {t.mergeInto(c.issue.key)}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={mutation.pending}
                      onClick={() => mutation.run(() => send(issuesPath(project.id, `/duplicates/${encodeURIComponent(c.id)}/reject`), "POST"))}
                    >
                      {t.reject}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel work-stack" aria-labelledby="issue-reports">
        <h3 id="issue-reports">{t.reports}</h3>
        <ul className="support-rows">
          {d.reports.map((r) => (
            <li key={r.id} className="work-stack">
              <div className="support-row-badges">
                <Badge>{t.source[r.sourceKind] ?? r.sourceKind}</Badge>
                <span className="support-muted">{when(r.occurredAt, locale)}</span>
                {Object.values(r.redaction).reduce((a, n) => a + n, 0) > 0 && (
                  <Badge tone="warning">{t.redacted(Object.values(r.redaction).reduce((a, n) => a + n, 0))}</Badge>
                )}
                {r.erased && <Badge>{t.erased}</Badge>}
              </div>
              <strong>{r.title}</strong>
              {r.symptoms && <p style={{ whiteSpace: "pre-wrap" }}>{r.symptoms}</p>}
              {r.diagnostics && Object.keys(r.diagnostics).length > 0 && (
                <details>
                  <summary>{t.diagnostics}</summary>
                  <dl className="home-counts">
                    {Object.entries(r.diagnostics).map(([k, v]) => (
                      <div key={k}>
                        <dt>{k}</dt>
                        <dd>{String(v)}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="panel work-stack" aria-labelledby="issue-deliveries">
        <div className="panel-head">
          <h3 id="issue-deliveries">{t.deliveries}</h3>
          {access.triage && issue.status !== "duplicate" && (
            <Button size="sm" variant="outline" onClick={() => setRecording(true)}>
              {t.recordDelivery}
            </Button>
          )}
        </div>
        <p className="support-muted">{t.mergedNotReleased}</p>
        {!d.deliveries.length ? <Empty title={t.none} /> : <DeliveryList t={t} items={d.deliveries} locale={locale} />}
      </section>

      <section className="panel work-stack" aria-labelledby="issue-history">
        <h3 id="issue-history">{t.timeline}</h3>
        <ul className="settings-rows">
          {d.timeline.map((e) => (
            <li key={e.id} className="work-settings-row">
              <span>{when(e.createdAt, locale)}</span>
              <span>
                {e.type}
                {typeof e.after.status === "string" && ` → ${t.status[e.after.status as keyof IssuesText["status"]] ?? e.after.status}`}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {merging && <MergeDialog t={t} issueId={issue.id} version={issue.version} onClose={() => setMerging(false)} onDone={() => { setMerging(false); changed(); }} />}
      {recording && <DeliveryForm t={t} base={base} onClose={() => setRecording(false)} onDone={() => { setRecording(false); changed(); }} />}
    </article>
  );
}

function AiSuggestion({
  t,
  suggestion,
  issueVersion,
  forVersion,
  base,
  canApply,
  onDone,
}: {
  t: IssuesText;
  suggestion: NonNullable<IssueDetail["issue"]["aiTriage"]["suggestion"]>;
  issueVersion: number;
  forVersion?: number;
  base: string;
  canApply: boolean;
  onDone: () => void;
}) {
  const [fields, setFields] = useState<string[]>(["severity", "priority"]);
  const mutation = useMutation(onDone);
  const toggle = (f: string) => setFields(fields.includes(f) ? fields.filter((x) => x !== f) : [...fields, f]);
  const rows: Array<[string, string]> = [
    ["type", t.type[suggestion.type]],
    ["severity", t.severity[suggestion.severity]],
    ["priority", t.priority[suggestion.priority]],
    ["components", suggestion.components.join(", ") || "—"],
  ];
  return (
    <section className="panel work-stack" aria-labelledby="issue-ai">
      <div className="panel-head">
        <h3 id="issue-ai">{t.ai.title}</h3>
        <span className="support-muted">
          {t.ai.confidence(suggestion.confidence)}
          {forVersion !== undefined && forVersion !== issueVersion - 1 && forVersion !== issueVersion ? ` · ${t.ai.stale}` : ""}
        </span>
      </div>
      <p>{suggestion.rationale}</p>
      <p>{suggestion.createTask ? t.ai.createTask : t.ai.noTask}</p>
      <ul className="settings-rows">
        {rows.map(([f, v]) => (
          <li key={f} className="work-settings-row">
            <label className="support-check">
              {canApply && <input type="checkbox" checked={fields.includes(f)} onChange={() => toggle(f)} />}
              {t.fields[f as keyof IssuesText["fields"]]}
            </label>
            <span>{v}</span>
          </li>
        ))}
      </ul>
      {suggestion.missingInformation.length > 0 && (
        <>
          <h4>{t.ai.questions}</h4>
          <ul>{suggestion.missingInformation.map((q, i) => <li key={i}>{q}</li>)}</ul>
        </>
      )}
      {suggestion.reproductionSteps.length > 0 && (
        <>
          <h4>{t.ai.steps}</h4>
          <ol>{suggestion.reproductionSteps.map((s, i) => <li key={i}>{s}</li>)}</ol>
        </>
      )}
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {canApply && (
        <Button size="sm" disabled={!fields.length || mutation.pending} onClick={() => mutation.run(() => send(`${base}/triage/apply`, "POST", { expectedVersion: issueVersion, fields }))}>
          {t.ai.apply}
        </Button>
      )}
    </section>
  );
}

function LinkList({ t, links }: { t: IssuesText; links: IssueDetail["links"] }) {
  const { locale } = useWorkspace();
  if (!links.length) return <Empty title={t.none} />;
  return (
    <ul className="support-rows">
      {links.map((l) => (
        <li key={l.id}>
          {l.object.state === "ok" && l.object.href ? (
            <AppLink className="support-row" href={l.object.href}>
              <span className="support-row-title">{l.object.title}</span>
              <span className="support-row-meta">
                {l.object.label?.[locale] ?? l.object.type}
                {l.object.status && ` · ${l.object.status}`}
              </span>
            </AppLink>
          ) : (
            <span className="support-row">
              <span className="support-row-title">
                {l.object.label?.[locale] ?? l.object.type} ({l.object.state === "restricted" ? t.restricted : t.missing})
              </span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function LinkTask({ t, base, onLinked }: { t: IssuesText; base: string; onLinked: () => void }) {
  const { project } = useWorkspace();
  const [q, setQ] = useState("");
  const targets = useResource<{ items: Array<{ id: string; title: string }> }>(
    q.trim().length >= 1 ? issuesPath(project.id, `/link-targets?type=work.task&q=${encodeURIComponent(q.trim())}`) : null,
  );
  const mutation = useMutation(onLinked);
  return (
    <div className="work-stack">
      <Input aria-label={t.linkTask} placeholder={t.linkTask} value={q} onChange={(e) => setQ(e.target.value)} />
      {(targets.data?.items ?? []).slice(0, 5).map((task) => (
        <Button
          key={task.id}
          size="sm"
          variant="ghost"
          disabled={mutation.pending}
          onClick={() => mutation.run(() => send(`${base}/links`, "POST", { targetType: "work.task", targetId: task.id, relation: "implements" }))}
        >
          {task.title}
        </Button>
      ))}
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
    </div>
  );
}

function MergeDialog({ t, issueId, version, onClose, onDone }: { t: IssuesText; issueId: string; version: number; onClose: () => void; onDone: () => void }) {
  const { project } = useWorkspace();
  const [number, setNumber] = useState("");
  const mutation = useMutation(onDone);
  return (
    <Modal title={t.merge} onClose={onClose}>
      <form
        className="support-form work-stack"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.run(async () => {
            const found = await api<IssuePage>(issuesPath(project.id, `/list?status=all&q=${encodeURIComponent(`ISS-${number}`)}`));
            const target = found.items.find((i) => i.number === Number(number));
            if (!target) throw new Error("ISSUES_NOT_FOUND");
            await send(issuesPath(project.id, `/issues/${encodeURIComponent(issueId)}/merge`), "POST", { targetIssueId: target.id, expectedVersion: version });
          });
        }}
      >
        <p className="support-muted">{t.mergeHint}</p>
        <label>
          {t.mergeTarget}
          <Input required inputMode="numeric" pattern="[0-9]+" value={number} onChange={(e) => setNumber(e.target.value)} autoFocus />
        </label>
        {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
        <div className="work-actions">
          <Button type="submit" disabled={mutation.pending || !number}>
            {t.merge}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t.cancel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeliveryForm({ t, base, onClose, onDone }: { t: IssuesText; base: string; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ kind: "pr_merged", repository: "", prNumber: "", commitSha: "", environment: "production" });
  const mutation = useMutation(onDone);
  return (
    <Modal title={t.recordDelivery} onClose={onClose}>
      <form
        className="support-form work-stack"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.run(() =>
            send(`${base}/deliveries`, "POST", {
              kind: form.kind,
              ...(form.repository ? { repository: form.repository } : {}),
              ...(form.prNumber ? { prNumber: Number(form.prNumber) } : {}),
              ...(form.commitSha ? { commitSha: form.commitSha } : {}),
              ...(form.kind === "deployed" ? { environment: form.environment } : {}),
            }),
          );
        }}
      >
        <p className="support-muted">{t.mergedNotReleased}</p>
        <label>
          {t.recordDelivery}
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            {["pr_opened", "pr_merged", "deployed", "verified"].map((k) => (
              <option key={k} value={k}>
                {t.deliveryKind[k]}
              </option>
            ))}
          </select>
        </label>
        <div className="support-controls">
          <label>
            {t.repository}
            <Input value={form.repository} pattern="[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+" onChange={(e) => setForm({ ...form, repository: e.target.value })} />
          </label>
          <label>
            {t.prNumber}
            <Input inputMode="numeric" pattern="[0-9]*" value={form.prNumber} onChange={(e) => setForm({ ...form, prNumber: e.target.value })} />
          </label>
          <label>
            {t.commit}
            <Input pattern="[0-9a-f]{7,40}" value={form.commitSha} onChange={(e) => setForm({ ...form, commitSha: e.target.value })} />
          </label>
          {form.kind === "deployed" && (
            <label>
              {t.fields.environment}
              <Input required pattern="[A-Za-z0-9._\-]{1,40}" value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })} />
            </label>
          )}
        </div>
        {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
        <div className="work-actions">
          <Button type="submit" disabled={mutation.pending}>
            {t.save}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t.cancel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function DeliveryList({ t, items, locale }: { t: IssuesText; items: Delivery[]; locale: "en" | "de" }) {
  return (
    <ul className="settings-rows">
      {items.map((x) => (
        <li key={x.id} className="work-settings-row">
          <Badge tone={x.kind === "deployed" ? "success" : "neutral"}>{t.deliveryKind[x.kind]}</Badge>
          <span>
            {[x.environment, x.repository && `${x.repository}${x.prNumber ? `#${x.prNumber}` : ""}`, x.commitSha?.slice(0, 7)].filter(Boolean).join(" · ")}
          </span>
          <span className="support-muted">{when(x.observedAt, locale)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Opens an issue's list entry from anywhere in the app. */
export function IssueLink({ issueId, children }: { issueId: string; children: React.ReactNode }) {
  const shell = useShell();
  return <AppLink href={`${shell.hrefOf("issues-list")}?issue=${encodeURIComponent(issueId)}`}>{children}</AppLink>;
}
