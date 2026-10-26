"use client";
import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { useMutation, useResource } from "@/lib/api";
import { Alert, Badge, Button, Empty, Input, Loading, Modal, Textarea } from "@/components/ui/primitives";
import { ChatMarkdown } from "@/components/chat-markdown";
import { useWorkspace } from "@/components/workspace-context";
import { AppLink } from "@/platform/ui/app-link";
import { ResourceError } from "@/platform/ui/collection";
import { day, PRIORITIES, send, workPath, type Priority } from "./api";
import { pmText, usd, type PmText } from "./pm-labels";
import { memberName, useWorkAccess, useWorkLists } from "./shared";

// The AI project manager in the initiative view (ADR 0017, plan §5): its
// state and budget, the monitor's findings, the latest AI report, the
// initiative's plans, and the review of one plan (?plan=<id>). Everything
// it writes waits for an approval in Orbit's decisions.

export type PmStatus = { available: boolean; budget?: { spentMicros: number; ceilingMicros: number } };
export type PmState = {
  initiativeId: string;
  enabled: boolean;
  settings: { reportSchedule: "off" | "weekly" | "daily"; research: "off" | "knowledge" | "web"; escalateTo: string[] };
  lastScanAt: string | null;
  lastReportAt: string | null;
  version: number;
};
export type Finding = {
  id: string;
  rule: string;
  severity: "info" | "warning" | "critical";
  taskIds: string[];
  data: Record<string, unknown>;
  firstSeenAt: string;
};
export type Report = { id: string; body: string; createdAt: string; costMicros: number };
export type PlanTask = {
  ref: string;
  title: string;
  description: string;
  workstreamRef: string | null;
  milestoneRef: string | null;
  parentRef: string | null;
  priority: Priority;
  estimate: number | null;
  dueDate: string | null;
  suggestedRole: string | null;
  suggestedAssigneeUserId: string | null;
  acceptanceCriteria: string[];
  dependsOn: string[];
};
export type WorkPlan = {
  goal: string;
  scope: { in: string[]; out: string[] };
  initiative: { title: string; key: string | null; startDate: string | null; targetDate: string | null };
  workstreams: Array<{ ref: string; title: string; summary: string }>;
  milestones: Array<{ ref: string; title: string; dueDate: string | null; criteria: string }>;
  tasks: PlanTask[];
  risks: Array<{ title: string; impact: string; mitigation: string }>;
  openDecisions: Array<{ question: string; options: string[]; recommendation: string | null }>;
  assumptions: string[];
};
export type Proposal = {
  id: string;
  initiativeId: string | null;
  kind: "new_plan" | "extension" | "adjustment";
  status: string;
  revision: number;
  plan: WorkPlan | null;
  validation: { errors: string[]; warnings: string[] };
  actionRequestId: string | null;
  costMicros: number;
  errorCode: string | null;
  version: number;
  createdAt: string;
};

/** Whether the PM runs here (ORBIT_WORK_PM and the module), with today's budget. */
export function usePmStatus() {
  const { project } = useWorkspace();
  return useResource<PmStatus>(workPath(project.id, "/pm/status"));
}

const SEVERITY_TONE = { critical: "danger", warning: "warning", info: "neutral" } as const;
const OPEN_PLAN = ["queued", "running", "draft", "proposed", "invalid"];

/** The PM panel of an initiative. */
export function PmPanel({
  initiativeId,
  onChanged,
  onOpenPlan,
}: {
  initiativeId: string;
  onChanged?: () => void;
  onOpenPlan: (id: string) => void;
}) {
  const { project, locale } = useWorkspace();
  const t = pmText(locale);
  const access = useWorkAccess();
  const status = usePmStatus();
  const available = status.data?.available === true;
  const base = (rest: string) => (available ? workPath(project.id, `/pm${rest}`) : null);
  const state = useResource<PmState>(base(`/initiatives/${initiativeId}/state`));
  const findings = useResource<{ items: Finding[] }>(base(`/findings?initiativeId=${initiativeId}`));
  const reports = useResource<{ items: Report[] }>(base(`/reports?initiativeId=${initiativeId}`));
  const plans = useResource<{ items: Proposal[] }>(base(`/plans?initiativeId=${initiativeId}`));
  const [notice, setNotice] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const refresh = () => {
    state.refresh();
    findings.refresh();
    reports.refresh();
    plans.refresh();
    status.refresh();
    onChanged?.();
  };
  const mutation = useMutation(refresh);
  if (!available) return null;
  const s = state.data;
  const report = reports.data?.items[0];
  const budget = status.data?.budget;
  const saveState = (patch: Record<string, unknown>) =>
    s && mutation.run(() => send(workPath(project.id, `/pm/initiatives/${initiativeId}/state`), "PUT", { expectedVersion: s.version, ...patch }));
  return (
    <section className="work-section work-pm" aria-labelledby="work-pm-head">
      <div className="work-section-head">
        <h2 id="work-pm-head">
          <Sparkles aria-hidden /> {t.title}
        </h2>
        {access.write && (
          <div className="form-actions">
            <Button size="sm" variant="outline" onClick={() => setPlanning(true)}>
              {t.extendWithAi}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={mutation.pending}
              onClick={() =>
                mutation.run(async () => {
                  const r = await send<{ status: string }>(workPath(project.id, "/pm/reports"), "POST", { initiativeId });
                  setNotice(r.status === "unchanged" ? t.reportUnchanged : t.queued);
                })
              }
            >
              {t.statusReport}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={mutation.pending}
              onClick={() =>
                mutation.run(async () => {
                  await send(workPath(project.id, "/pm/analyses"), "POST", { initiativeId });
                  setNotice(t.queued);
                })
              }
            >
              {t.analyse}
            </Button>
          </div>
        )}
      </div>
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {notice && <Alert kind="info">{notice}</Alert>}
      {budget && <p className="support-muted">{t.budgetToday(usd(budget.spentMicros), usd(budget.ceilingMicros))}</p>}
      {state.loading ? (
        <Loading />
      ) : state.error ? (
        <ResourceError error={state.error} retry={state.refresh} />
      ) : s ? (
        <div className="work-pm-state">
          <p>{s.enabled ? t.watching : t.notWatching}</p>
          {access.owner && (
            <div className="form-actions">
              <Button size="sm" variant={s.enabled ? "outline" : "default"} disabled={mutation.pending} onClick={() => saveState({ enabled: !s.enabled })}>
                {s.enabled ? t.stopWatching : t.watch}
              </Button>
              <label>
                {t.schedule}{" "}
                <select
                  value={s.settings.reportSchedule}
                  disabled={mutation.pending}
                  onChange={(e) => saveState({ settings: { reportSchedule: e.target.value } })}
                >
                  {Object.entries(t.schedules).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t.research}{" "}
                <select value={s.settings.research} disabled={mutation.pending} onChange={(e) => saveState({ settings: { research: e.target.value } })}>
                  {Object.entries(t.researchModes).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </div>
      ) : null}
      <h3>{t.findings}</h3>
      {!findings.data?.items.length ? (
        <p className="support-muted">{t.noFindings}</p>
      ) : (
        <ul className="work-pm-findings">
          {findings.data.items.map((f) => (
            <li key={f.id}>
              <Badge tone={SEVERITY_TONE[f.severity]}>{t.severity[f.severity]}</Badge> {t.rules[f.rule] ?? f.rule}
              {typeof f.data.number === "number" && ` · #${f.data.number}`}
              {access.write && (
                <Button size="sm" variant="ghost" disabled={mutation.pending} onClick={() => mutation.run(() => send(workPath(project.id, `/pm/findings/${f.id}/dismiss`), "POST", {}))}>
                  {t.dismiss}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <h3>{t.lastReport}</h3>
      {report ? (
        <article className="work-pm-report">
          <p className="support-muted">
            {t.aiLabel} · {day(report.createdAt.slice(0, 10), locale)}
          </p>
          <ChatMarkdown text={report.body} />
        </article>
      ) : (
        <p className="support-muted">{t.noReport}</p>
      )}
      <PlanList plans={plans.data?.items ?? []} t={t} onOpen={onOpenPlan} />
      {planning && (
        <PlanRequest
          initiativeId={initiativeId}
          onClose={() => setPlanning(false)}
          onSent={() => {
            setPlanning(false);
            setNotice(t.queued);
            refresh();
          }}
        />
      )}
    </section>
  );
}

function PlanList({ plans, t, onOpen }: { plans: Proposal[]; t: PmText; onOpen: (id: string) => void }) {
  const open = plans.filter((p) => p.kind !== "adjustment" || OPEN_PLAN.includes(p.status));
  if (!open.length) return null;
  return (
    <>
      <h3>{t.plans}</h3>
      <ul className="support-rows">
        {open.map((p) => (
          <li key={p.id}>
            <button type="button" className="support-row" onClick={() => onOpen(p.id)}>
              <span className="support-row-title">
                {p.plan?.initiative.title ?? t.plans} · r{p.revision}
              </span>
              <span className="support-row-badges">
                <Badge tone={p.status === "invalid" || p.status === "failed" ? "danger" : p.status === "proposed" ? "warning" : "neutral"}>
                  {t.planStatus[p.status] ?? p.status}
                </Badge>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Asks the PM for a plan: a new initiative, or more work for one. */
export function PlanRequest({ initiativeId, onClose, onSent }: { initiativeId?: string; onClose: () => void; onSent: () => void }) {
  const { project, locale } = useWorkspace();
  const t = pmText(locale);
  const [goal, setGoal] = useState("");
  const [constraints, setConstraints] = useState("");
  const mutation = useMutation(onSent);
  return (
    <Modal title={t.requestPlan} onClose={onClose}>
      <form
        className="work-stack"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.run(() =>
            send(workPath(project.id, "/pm/plans"), "POST", {
              goal,
              ...(constraints.trim() ? { constraints } : {}),
              initiativeId: initiativeId ?? null,
            }),
          );
        }}
      >
        {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
        <label>
          {t.goal}
          <Textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={4} maxLength={3000} required />
        </label>
        <label>
          {t.constraints}
          <Textarea value={constraints} onChange={(e) => setConstraints(e.target.value)} rows={3} maxLength={900} />
        </label>
        <div className="form-actions">
          <Button type="submit" disabled={mutation.pending || goal.trim().length < 3}>
            {t.send}
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>
            {t.cancel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** "Plan with AI" on the initiatives list, for a new initiative. */
export function PlanWithAiButton() {
  const { locale } = useWorkspace();
  const t = pmText(locale);
  const access = useWorkAccess();
  const status = usePmStatus();
  const [open, setOpen] = useState(false);
  if (!status.data?.available || !access.write) return null;
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Sparkles aria-hidden /> {t.planWithAi}
      </Button>
      {open && <PlanRequest onClose={() => setOpen(false)} onSent={() => setOpen(false)} />}
    </>
  );
}

/** The open plans of the project that belong to no initiative yet. */
export function NewPlans({ onOpen }: { onOpen: (id: string) => void }) {
  const { project, locale } = useWorkspace();
  const t = pmText(locale);
  const status = usePmStatus();
  const plans = useResource<{ items: Proposal[] }>(status.data?.available ? workPath(project.id, "/pm/plans?open=true") : null);
  const items = (plans.data?.items ?? []).filter((p) => !p.initiativeId);
  if (!items.length) return null;
  return (
    <section className="work-section" aria-labelledby="work-new-plans">
      <h2 id="work-new-plans">{t.plans}</h2>
      <ul className="support-rows">
        {items.map((p) => (
          <li key={p.id}>
            <button type="button" className="support-row" onClick={() => onOpen(p.id)}>
              <span className="support-row-title">{p.plan?.initiative.title ?? t.planStatus[p.status]}</span>
              <span className="support-row-badges">
                <Badge>{t.planStatus[p.status] ?? p.status}</Badge>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One plan proposal: its validation, the plan as a tree, edits and its approval state. */
export function PlanReview({ planId, onClose, onOpen }: { planId: string; onClose: () => void; onOpen: (id: string) => void }) {
  const { project, locale } = useWorkspace();
  const t = pmText(locale);
  const access = useWorkAccess();
  const lists = useWorkLists();
  const proposal = useResource<Proposal>(workPath(project.id, `/pm/plans/${planId}`));
  // The member's edits; until the first one the stored plan is shown.
  const [edited, setEdited] = useState<WorkPlan | null>(null);
  useEffect(() => setEdited(null), [proposal.data]);
  const mutation = useMutation(proposal.refresh);
  if (proposal.loading) return <Loading />;
  if (proposal.error) return <ResourceError error={proposal.error} retry={proposal.refresh} />;
  const p = proposal.data!;
  const draft = edited ?? p.plan;
  const editable = access.write && ["draft", "proposed", "invalid"].includes(p.status);
  const changed = edited !== null && JSON.stringify(edited) !== JSON.stringify(p.plan);
  const setTask = (ref: string, patch: Partial<PlanTask>) =>
    draft && setEdited({ ...draft, tasks: draft.tasks.map((task) => (task.ref === ref ? { ...task, ...patch } : task)) });
  const removeTask = (ref: string) =>
    draft &&
    setEdited({
      ...draft,
      tasks: draft.tasks
        .filter((task) => task.ref !== ref && task.parentRef !== ref)
        .map((task) => ({ ...task, dependsOn: task.dependsOn.filter((d) => d !== ref) })),
    });
  const tasksOf = (milestoneRef: string | null) => (draft?.tasks ?? []).filter((task) => task.milestoneRef === milestoneRef);
  return (
    <div className="support-page work-plan">
      <Button variant="ghost" size="sm" onClick={onClose}>
        ← {t.cancel}
      </Button>
      <h1>
        {draft?.initiative.title ?? t.plans} <Badge>{t.planStatus[p.status] ?? p.status}</Badge> <span className="support-muted">r{p.revision}</span>
      </h1>
      <p className="support-muted">
        {t.aiLabel}
        {p.costMicros > 0 && ` · ${t.costs(usd(p.costMicros))}`}
      </p>
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {p.errorCode && p.status === "failed" && (
        <Alert kind="error">
          {t.failure(p.errorCode)}
          {access.write && (
            <>
              {" "}
              <Button
                size="sm"
                variant="outline"
                disabled={mutation.pending}
                onClick={() =>
                  mutation.run(async () => {
                    const next = await send<{ id: string }>(workPath(project.id, `/pm/plans/${p.id}/retry`), "POST", {});
                    onOpen(next.id);
                  })
                }
              >
                {t.retryPlan}
              </Button>
            </>
          )}
        </Alert>
      )}
      {p.validation.errors.length > 0 && (
        <Alert kind="error">
          {t.errors}: {p.validation.errors.join(", ")}
        </Alert>
      )}
      {p.validation.warnings.length > 0 && (
        <Alert kind="info">
          {t.warnings}: {p.validation.warnings.join(", ")}
        </Alert>
      )}
      {p.status === "proposed" && (
        <Alert kind="info">
          {t.approveHint} <AppLink href="/decisions">{t.openDecisions}</AppLink>
        </Alert>
      )}
      {!draft ? (
        <Empty title={t.planStatus[p.status] ?? p.status} />
      ) : p.kind === "adjustment" ? (
        <pre className="work-pm-adjustment">{JSON.stringify(draft, null, 2)}</pre>
      ) : (
        <>
          <p>{draft.goal}</p>
          <dl className="work-facts">
            <div>
              <dt>{t.scopeIn}</dt>
              <dd>{draft.scope.in.join("; ") || "—"}</dd>
            </div>
            <div>
              <dt>{t.scopeOut}</dt>
              <dd>{draft.scope.out.join("; ") || "—"}</dd>
            </div>
          </dl>
          {[...draft.milestones.map((m) => ({ ref: m.ref as string | null, title: `${m.title} · ${day(m.dueDate, locale)}`, criteria: m.criteria })), { ref: null, title: t.tasks, criteria: "" }].map(
            (group) =>
              tasksOf(group.ref).length > 0 && (
                <section key={group.ref ?? "none"} className="work-section">
                  <h2>{group.title}</h2>
                  {group.criteria && <p className="support-muted">{group.criteria}</p>}
                  <ul className="work-plan-tasks">
                    {tasksOf(group.ref).map((task) => (
                      <li key={task.ref} className={task.parentRef ? "work-plan-subtask" : undefined}>
                        <div className="work-plan-task">
                          <span className="support-muted">{task.ref}</span>
                          {editable ? (
                            <Input aria-label={task.ref} value={task.title} maxLength={300} onChange={(e) => setTask(task.ref, { title: e.target.value })} />
                          ) : (
                            <strong>{task.title}</strong>
                          )}
                          <select
                            aria-label={`${task.ref} priority`}
                            value={task.priority}
                            disabled={!editable}
                            onChange={(e) => setTask(task.ref, { priority: e.target.value as Priority })}
                          >
                            {PRIORITIES.map((value) => (
                              <option key={value} value={value}>
                                {value}
                              </option>
                            ))}
                          </select>
                          <Input
                            type="date"
                            aria-label={`${task.ref} due`}
                            value={task.dueDate ?? ""}
                            disabled={!editable}
                            onChange={(e) => setTask(task.ref, { dueDate: e.target.value || null })}
                          />
                          <select
                            aria-label={`${task.ref} assignee`}
                            value={task.suggestedAssigneeUserId ?? ""}
                            disabled={!editable}
                            onChange={(e) => setTask(task.ref, { suggestedAssigneeUserId: e.target.value || null })}
                          >
                            <option value="">—</option>
                            {lists.members
                              .filter((m) => m.role !== "viewer")
                              .map((m) => (
                                <option key={m.userId} value={m.userId}>
                                  {memberName(lists.members, m.userId, locale)}
                                </option>
                              ))}
                          </select>
                          {editable && (
                            <Button size="sm" variant="ghost" onClick={() => removeTask(task.ref)}>
                              {t.remove}
                            </Button>
                          )}
                        </div>
                        {task.dependsOn.length > 0 && (
                          <p className="support-muted">
                            {t.dependsOn} {task.dependsOn.join(", ")}
                          </p>
                        )}
                        {task.acceptanceCriteria.length > 0 && (
                          <ul className="support-muted">
                            {task.acceptanceCriteria.map((c, i) => (
                              <li key={i}>{c}</li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ),
          )}
          {draft.risks.length > 0 && (
            <section className="work-section">
              <h2>{t.risks}</h2>
              <ul>
                {draft.risks.map((r, i) => (
                  <li key={i}>
                    {r.title} ({r.impact}){r.mitigation && ` — ${r.mitigation}`}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {draft.openDecisions.length > 0 && (
            <section className="work-section">
              <h2>{t.openDecisions}</h2>
              <ul>
                {draft.openDecisions.map((d, i) => (
                  <li key={i}>
                    {d.question}
                    {d.options.length > 0 && ` (${d.options.join(" / ")})`}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {draft.assumptions.length > 0 && (
            <section className="work-section">
              <h2>{t.assumptions}</h2>
              <ul>
                {draft.assumptions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      {editable && (
        <div className="form-actions">
          {p.kind !== "adjustment" && (
            <Button
              disabled={!changed || mutation.pending}
              onClick={() =>
                mutation.run(async () => {
                  const next = await send<Proposal>(workPath(project.id, `/pm/plans/${p.id}/revisions`), "POST", { expectedVersion: p.version, plan: draft });
                  onOpen(next.id);
                })
              }
            >
              {t.saveRevision}
            </Button>
          )}
          <Button variant="outline" disabled={mutation.pending} onClick={() => mutation.run(() => send(workPath(project.id, `/pm/plans/${p.id}/discard`), "POST", {}))}>
            {t.discard}
          </Button>
        </div>
      )}
    </div>
  );
}
