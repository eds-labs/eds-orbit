"use client";
import { useEffect, useState } from "react";
import { api, collectionPath, useResource, when } from "@/lib/api";
import { Alert, Button, Status } from "./ui/primitives";
import { useWorkspace } from "./workspace-context";

export type RunStep = {
  id: string;
  type: string;
  name: string;
  model: string | null;
  status: string;
  errorCode: string | null;
  attempt: number;
  startedAt: string;
  durationMs: number;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  costMicros: string | null;
};
type AgentRun = {
  id: string;
  kind: string;
  agentName: string;
  status: string;
  errorCode: string | null;
  startedAt: string;
  modelCalls: number;
  toolCalls: number;
  costMicros: string;
};

const stepTypes: Record<string, [string, string]> = {
  model_call: ["Model call", "Modellaufruf"],
  tool_call: ["Tool", "Tool"],
  embedding: ["Embedding", "Embedding"],
  image: ["Image", "Bild"],
};
// Single AI calls cost fractions of a cent, so show micro-USD exactly.
const exactUsd = (micros: string | null) =>
  micros === null ? "—" : `$${(Number(micros) / 1_000_000).toFixed(6)}`;

export function RunStepList({ steps, de }: { steps: RunStep[]; de: boolean }) {
  if (!steps.length)
    return (
      <p className="panel-note">
        {de ? "Keine Schritte aufgezeichnet." : "No steps recorded."}
      </p>
    );
  return (
    <ol className="run-steps">
      {steps.map((step) => (
        <li key={step.id}>
          <strong>
            {(stepTypes[step.type] ?? [step.type, step.type])[de ? 1 : 0]}:{" "}
            {step.name}
          </strong>{" "}
          <Status value={step.status} />
          {step.errorCode && <code> {step.errorCode}</code>}
          <small>
            {[
              step.model,
              `${step.durationMs} ms`,
              step.inputTokens !== null
                ? `${de ? "Tokens" : "tokens"} ${step.inputTokens} / ${step.outputTokens ?? 0}`
                : null,
              step.costMicros !== null ? exactUsd(step.costMicros) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </small>
        </li>
      ))}
    </ol>
  );
}

type RunPage = { runs: AgentRun[]; nextCursor: string | null };

/** Runs shown at first and added per "Show more"; the API pages by 50. */
export const RUNS_PAGE = 10;

/** The "Show more" label: the runs still loaded, else the next page of the API. */
export function moreRunsLabel(hidden: number, nextPage: boolean, de: boolean) {
  if (hidden > 0)
    return de ? `${hidden} weitere anzeigen` : `Show ${hidden} more`;
  return nextPage ? (de ? "Ältere Läufe laden" : "Load older runs") : null;
}

// Recent AI runs of the project, ten at a time; each run's steps load on
// request, older pages when asked for.
export function AgentRuns() {
  const { locale, project, revision, canEdit } = useWorkspace();
  const de = locale === "de";
  const runs = useResource<RunPage>(
    canEdit
      ? collectionPath(project.id, `agent-runs?revision=${revision}`)
      : null,
  );
  const [open, setOpen] = useState<string | null>(null);
  const [steps, setSteps] = useState<Record<string, RunStep[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(RUNS_PAGE);
  // Older pages loaded on request; a reload of the first page drops them.
  const [older, setOlder] = useState<RunPage>({ runs: [], nextCursor: null });
  const [loadingOlder, setLoadingOlder] = useState(false);
  useEffect(() => {
    setOlder({ runs: [], nextCursor: null });
    setShown(RUNS_PAGE);
  }, [runs.data]);
  if (!canEdit || !runs.data?.runs.length) return null;
  const all = [...runs.data.runs, ...older.runs];
  const nextCursor = older.runs.length
    ? older.nextCursor
    : runs.data.nextCursor;
  const hidden = Math.max(0, all.length - shown);
  const more = moreRunsLabel(hidden, nextCursor !== null, de);
  const showMore = async () => {
    if (hidden > 0) return setShown((n) => n + RUNS_PAGE);
    if (!nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    setError(null);
    try {
      const page = await api<RunPage>(
        collectionPath(
          project.id,
          `agent-runs?cursor=${encodeURIComponent(nextCursor)}`,
        ),
      );
      setOlder((current) => ({
        runs: [...current.runs, ...page.runs],
        nextCursor: page.nextCursor,
      }));
      setShown((n) => n + RUNS_PAGE);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed.");
    } finally {
      setLoadingOlder(false);
    }
  };
  const toggle = async (id: string) => {
    if (open === id) return setOpen(null);
    setOpen(id);
    setError(null);
    if (steps[id]) return;
    try {
      const result = await api<{ items: RunStep[] }>(
        collectionPath(project.id, `agent-runs/${id}/spans`),
      );
      setSteps((current) => ({ ...current, [id]: result.items }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed.");
    }
  };
  return (
    <section className="panel administration-panel">
      <div className="panel-head">
        <div>
          <h2>{de ? "KI-Läufe" : "AI runs"}</h2>
          <p>
            {de
              ? "Die letzten Läufe mit ihren einzelnen Schritten: Modellaufrufe, Tools und Kosten."
              : "Recent runs with their individual steps: model calls, tools and cost."}
          </p>
        </div>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {all.slice(0, shown).map((run) => (
        <div className="data-row" key={run.id}>
          <div>
            <strong>
              {run.kind} · {run.agentName}
            </strong>
            <p>
              {when(run.startedAt, locale, project.timezone)} · {run.modelCalls}{" "}
              {de ? "Modellaufrufe" : "model calls"} · {run.toolCalls} Tools ·{" "}
              {exactUsd(run.costMicros)}
              {run.errorCode ? ` · ${run.errorCode}` : ""}
            </p>
            {open === run.id && steps[run.id] && (
              <RunStepList de={de} steps={steps[run.id]!} />
            )}
          </div>
          <Status value={run.status} />
          <Button variant="outline" size="sm" onClick={() => toggle(run.id)}>
            {open === run.id
              ? de
                ? "Schritte ausblenden"
                : "Hide steps"
              : de
                ? "Schritte"
                : "Steps"}
          </Button>
        </div>
      ))}
      {more && (
        <div className="form-actions">
          <Button
            variant="outline"
            size="sm"
            disabled={loadingOlder}
            onClick={showMore}
          >
            {more}
          </Button>
        </div>
      )}
    </section>
  );
}
