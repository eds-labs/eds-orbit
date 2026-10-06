"use client";
import { useState } from "react";
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

// Recent AI runs of the project; each run's steps load on request.
export function AgentRuns() {
  const { locale, project, revision, canEdit } = useWorkspace();
  const de = locale === "de";
  const runs = useResource<{ runs: AgentRun[] }>(
    canEdit
      ? collectionPath(project.id, `agent-runs?revision=${revision}`)
      : null,
  );
  const [open, setOpen] = useState<string | null>(null);
  const [steps, setSteps] = useState<Record<string, RunStep[]>>({});
  const [error, setError] = useState<string | null>(null);
  if (!canEdit || !runs.data?.runs.length) return null;
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
      {runs.data.runs.map((run) => (
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
    </section>
  );
}
