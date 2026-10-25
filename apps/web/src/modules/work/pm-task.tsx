"use client";
import { useEffect, useState } from "react";
import { Bot, Copy } from "lucide-react";
import { useMutation, useResource } from "@/lib/api";
import { Alert, Badge, Button, Input, Textarea } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { send, workPath } from "./api";
import { usePmStatus } from "./pm";
import { pmText, usd, type PmText } from "./pm-labels";
import { useWorkAccess } from "./shared";

// What the AI project manager does with one task (ADR 0017): handoffs to
// research or analysis, and coding work orders with their redacted brief,
// the owner's approval and the reported pull request. A finished target
// moves the task to review; a person marks it done.

type Handoff = { id: string; target: string; label: { en: string; de: string } | null; status: string; errorCode: string | null; createdAt: string };
type Target = { key: string; label: { en: string; de: string }; risk: string };
type Brief = {
  goal: string;
  description: string;
  acceptanceCriteria: string[];
  constraints: string[];
  doNotTouch: string[];
  testExpectations: string;
  repository: string;
  baseBranch: string;
};
type CodingRun = {
  id: string;
  repositoryKey: string;
  provider: "manual" | "automation";
  status: string;
  briefRevision: number;
  brief: Brief;
  briefMarkdown: string;
  sanitization: Record<string, number>;
  personalDataReviewed: boolean;
  ceilingMicros: number;
  reportedCostMicros: number | null;
  branch: string | null;
  prUrl: string | null;
  prNumber: number | null;
  commitSha: string | null;
  tests: { passed: number; failed: number; skipped: number } | null;
  summary: string | null;
  errorCode: string | null;
  version: number;
};
type Repository = { key: string; label: string; dispatch: { kind: string } };

const OPEN = ["dispatched", "running", "outcome_unknown"];
const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

export function TaskAgents({ taskId, onChanged }: { taskId: string; onChanged: () => void }) {
  const { project, locale } = useWorkspace();
  const t = pmText(locale);
  const access = useWorkAccess();
  const status = usePmStatus();
  const on = status.data?.available === true;
  const path = (rest: string) => (on ? workPath(project.id, `/pm${rest}`) : null);
  const handoffs = useResource<{ items: Handoff[] }>(path(`/tasks/${taskId}/handoffs`));
  const runs = useResource<{ items: CodingRun[] }>(path(`/coding-runs?taskId=${taskId}`));
  const targets = useResource<{ items: Target[] }>(on && access.write ? workPath(project.id, "/pm/handoff-targets") : null);
  const settings = useResource<{ settings: { repositories: Repository[] } }>(on && access.write ? workPath(project.id, "/pm/settings") : null);
  const refresh = () => {
    handoffs.refresh();
    runs.refresh();
    onChanged();
  };
  const mutation = useMutation(refresh);
  if (!on) return null;
  return (
    <section className="work-section work-pm" aria-labelledby="work-agents">
      <h3 id="work-agents">
        <Bot aria-hidden /> {t.title}
      </h3>
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {handoffs.data && handoffs.data.items.length > 0 && (
        <ul className="work-pm-findings">
          {handoffs.data.items.map((h) => (
            <li key={h.id}>
              {h.label?.[locale] ?? h.target} <Badge>{t.handoffStatus[h.status] ?? h.status}</Badge>
              {h.errorCode && <span className="support-muted"> {h.errorCode}</span>}
            </li>
          ))}
        </ul>
      )}
      {access.write && (targets.data?.items.length ?? 0) > 0 && (
        <HandoffForm targets={targets.data!.items.filter((x) => x.key.startsWith("work."))} t={t} pending={mutation.pending} onSend={(body) => mutation.run(() => send(workPath(project.id, `/pm/tasks/${taskId}/handoffs`), "POST", body))} />
      )}
      <h4>{t.coding}</h4>
      {(runs.data?.items ?? []).map((run) => (
        <CodingRunCard key={run.id} run={run} t={t} write={access.write} pending={mutation.pending} act={(rest, method, body) => mutation.run(() => send(workPath(project.id, `/pm/coding-runs/${run.id}${rest}`), method, body))} />
      ))}
      {access.write && (settings.data?.settings.repositories.length ?? 0) > 0 && (
        <NewCodingRun
          repositories={settings.data!.settings.repositories}
          t={t}
          pending={mutation.pending}
          onCreate={(body) => mutation.run(() => send(workPath(project.id, `/pm/tasks/${taskId}/coding-runs`), "POST", body))}
        />
      )}
    </section>
  );
}

function HandoffForm({ targets, t, pending, onSend }: { targets: Target[]; t: PmText; pending: boolean; onSend: (body: unknown) => void }) {
  const { locale } = useWorkspace();
  const [target, setTarget] = useState(targets[0]?.key ?? "");
  const [question, setQuestion] = useState("");
  const [web, setWeb] = useState(false);
  if (!targets.length) return null;
  return (
    <form
      className="work-stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSend({ target, input: target === "work.research" ? { question, web } : { question } });
        setQuestion("");
      }}
    >
      <label>
        {t.handoffTargets}{" "}
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          {targets.map((x) => (
            <option key={x.key} value={x.key}>
              {x.label[locale]}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t.question}
        <Textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={2} maxLength={2000} />
      </label>
      {target === "work.research" && (
        <label className="support-check">
          <input type="checkbox" checked={web} onChange={(e) => setWeb(e.target.checked)} /> {t.webResearch}
        </label>
      )}
      <div className="form-actions">
        <Button size="sm" type="submit" disabled={pending || question.trim().length < 3}>
          {t.handoff}
        </Button>
      </div>
    </form>
  );
}

function NewCodingRun({ repositories, t, pending, onCreate }: { repositories: Repository[]; t: PmText; pending: boolean; onCreate: (body: unknown) => void }) {
  const [repositoryKey, setRepositoryKey] = useState(repositories[0]!.key);
  const [aiDraft, setAiDraft] = useState(false);
  return (
    <div className="form-actions">
      <label>
        {t.repository}{" "}
        <select value={repositoryKey} onChange={(e) => setRepositoryKey(e.target.value)}>
          {repositories.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      <label className="support-check">
        <input type="checkbox" checked={aiDraft} onChange={(e) => setAiDraft(e.target.checked)} /> {t.draftWithAi}
      </label>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => onCreate({ repositoryKey, aiDraft })}>
        {t.newCodingRun}
      </Button>
    </div>
  );
}

function CodingRunCard({
  run,
  t,
  write,
  pending,
  act,
}: {
  run: CodingRun;
  t: PmText;
  write: boolean;
  pending: boolean;
  act: (rest: string, method: "POST" | "PATCH", body: unknown) => void;
}) {
  const removed = Object.values(run.sanitization).reduce((a, n) => a + n, 0);
  return (
    <article className="work-pm-run">
      <p>
        <strong>{run.repositoryKey}</strong> <Badge tone={run.status === "succeeded" ? "success" : run.status === "failed" || run.status === "outcome_unknown" ? "danger" : "neutral"}>{t.runStatus[run.status] ?? run.status}</Badge>
        {run.ceilingMicros > 0 && <span className="support-muted"> · {t.ceiling}: {usd(run.ceilingMicros)}</span>}
        {run.reportedCostMicros !== null && <span className="support-muted"> · {t.costs(usd(run.reportedCostMicros))}</span>}
      </p>
      {removed > 0 && <p className="support-muted">{t.removed(removed)}</p>}
      {run.prUrl && (
        <p>
          <a href={run.prUrl} target="_blank" rel="noreferrer noopener">
            PR #{run.prNumber}
          </a>
          {run.branch && ` · ${run.branch}`}
          {run.commitSha && ` · ${run.commitSha.slice(0, 7)}`}
          {run.tests && ` · ${run.tests.passed} ${t.testsPassed}, ${run.tests.failed} ${t.testsFailed}`}
        </p>
      )}
      {run.summary && (
        <p className="support-muted">
          {t.untrusted}: {run.summary}
        </p>
      )}
      {run.errorCode && <p className="support-muted">{run.errorCode}</p>}
      {run.status === "draft" && write ? (
        <BriefEditor run={run} t={t} pending={pending} act={act} />
      ) : (
        <details>
          <summary>{t.brief}</summary>
          <pre className="work-pm-brief">{run.briefMarkdown}</pre>
          <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(run.briefMarkdown)}>
            <Copy aria-hidden /> {t.copyBrief}
          </Button>
        </details>
      )}
      {write && run.provider === "manual" && OPEN.includes(run.status) && <ManualReport run={run} t={t} pending={pending} act={act} />}
      {write && ["draft", "awaiting_approval", ...OPEN].includes(run.status) && (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => act("/cancel", "POST", {})}>
          {t.cancel}
        </Button>
      )}
    </article>
  );
}

function BriefEditor({ run, t, pending, act }: { run: CodingRun; t: PmText; pending: boolean; act: (rest: string, method: "POST" | "PATCH", body: unknown) => void }) {
  const [goal, setGoal] = useState(run.brief.goal);
  const [description, setDescription] = useState(run.brief.description);
  const [criteria, setCriteria] = useState(run.brief.acceptanceCriteria.join("\n"));
  const [constraints, setConstraints] = useState(run.brief.constraints.join("\n"));
  const [doNotTouch, setDoNotTouch] = useState(run.brief.doNotTouch.join("\n"));
  const [tests, setTests] = useState(run.brief.testExpectations);
  useEffect(() => {
    setGoal(run.brief.goal);
    setDescription(run.brief.description);
    setCriteria(run.brief.acceptanceCriteria.join("\n"));
    setConstraints(run.brief.constraints.join("\n"));
    setDoNotTouch(run.brief.doNotTouch.join("\n"));
    setTests(run.brief.testExpectations);
  }, [run.brief]);
  const brief = {
    goal,
    description,
    acceptanceCriteria: lines(criteria),
    constraints: lines(constraints),
    doNotTouch: lines(doNotTouch),
    testExpectations: tests,
    baseBranch: run.brief.baseBranch,
  };
  // Saved text is redacted again on the server and needs a new review.
  const edited =
    goal !== run.brief.goal ||
    description !== run.brief.description ||
    criteria !== run.brief.acceptanceCriteria.join("\n") ||
    constraints !== run.brief.constraints.join("\n") ||
    doNotTouch !== run.brief.doNotTouch.join("\n") ||
    tests !== run.brief.testExpectations;
  return (
    <div className="work-stack">
      <label>
        {t.goal}
        <Input value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={2000} />
      </label>
      <label>
        {t.description}
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} maxLength={8000} />
      </label>
      <label>
        {t.criteria}
        <Textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} rows={3} />
      </label>
      <label>
        {t.constraints}
        <Textarea value={constraints} onChange={(e) => setConstraints(e.target.value)} rows={2} />
      </label>
      <label>
        {t.doNotTouch}
        <Textarea value={doNotTouch} onChange={(e) => setDoNotTouch(e.target.value)} rows={2} />
      </label>
      <label>
        {t.tests}
        <Input value={tests} onChange={(e) => setTests(e.target.value)} maxLength={1000} />
      </label>
      <div className="form-actions">
        <Button size="sm" variant="outline" disabled={pending || !edited || goal.trim().length < 3 || !brief.acceptanceCriteria.length} onClick={() => act("", "PATCH", { expectedVersion: run.version, brief })}>
          {t.saveBrief}
        </Button>
      </div>
      <label className="support-check">
        <input
          type="checkbox"
          checked={run.personalDataReviewed}
          disabled={pending || edited}
          onChange={(e) => act("", "PATCH", { expectedVersion: run.version, personalDataReviewed: e.target.checked })}
        />{" "}
        {t.reviewed}
      </label>
      <div className="form-actions">
        <Button size="sm" disabled={pending || edited || !run.personalDataReviewed} onClick={() => act("/submit", "POST", { expectedVersion: run.version })}>
          {t.submit}
        </Button>
      </div>
    </div>
  );
}

function ManualReport({ run, t, pending, act }: { run: CodingRun; t: PmText; pending: boolean; act: (rest: string, method: "POST" | "PATCH", body: unknown) => void }) {
  const [branch, setBranch] = useState(run.branch ?? "");
  const [prUrl, setPrUrl] = useState(run.prUrl ?? "");
  const [commit, setCommit] = useState(run.commitSha ?? "");
  const [passed, setPassed] = useState("");
  const [failed, setFailed] = useState("");
  const report = (status?: string) =>
    act("/manual", "PATCH", {
      expectedVersion: run.version,
      ...(status ? { status } : {}),
      ...(branch.trim() ? { branch: branch.trim() } : {}),
      ...(prUrl.trim() ? { prUrl: prUrl.trim() } : {}),
      ...(commit.trim() ? { commitSha: commit.trim() } : {}),
      ...(passed !== "" || failed !== "" ? { tests: { passed: Number(passed || 0), failed: Number(failed || 0), skipped: 0 } } : {}),
    });
  return (
    <details>
      <summary>{t.report}</summary>
      <div className="work-stack">
        <Input aria-label={t.branch} placeholder={t.branch} value={branch} onChange={(e) => setBranch(e.target.value)} />
        <Input aria-label={t.prUrl} placeholder={t.prUrl} value={prUrl} onChange={(e) => setPrUrl(e.target.value)} />
        <Input aria-label={t.commit} placeholder={t.commit} value={commit} onChange={(e) => setCommit(e.target.value)} />
        <div className="form-actions">
          <Input type="number" min={0} aria-label={t.testsPassed} placeholder={t.testsPassed} value={passed} onChange={(e) => setPassed(e.target.value)} />
          <Input type="number" min={0} aria-label={t.testsFailed} placeholder={t.testsFailed} value={failed} onChange={(e) => setFailed(e.target.value)} />
        </div>
        <div className="form-actions">
          {run.status !== "running" && (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => report("running")}>
              {t.markRunning}
            </Button>
          )}
          <Button size="sm" disabled={pending || !prUrl.trim()} onClick={() => report("succeeded")}>
            {t.markSucceeded}
          </Button>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => report("failed")}>
            {t.markFailed}
          </Button>
        </div>
      </div>
    </details>
  );
}
