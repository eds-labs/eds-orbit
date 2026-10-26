"use client";
// Search index generations (WP2.3b), moved unchanged from components/operator-tools.tsx.
import { useState } from "react";
import {
  action,
  collectionPath,
  useMutation,
  useResource,
  value,
  when,
} from "@/lib/api";
import {
  Alert,
  Button,
  Loading,
  Modal,
  Status,
} from "@/components/ui/primitives";
import { DataForm, options, str } from "@/platform/ui/form";
import { useWorkspace } from "@/components/workspace-context";
import { ResourceError } from "@/platform/ui/collection";
export type IndexGeneration = {
  id: string;
  generation: number;
  profile: string;
  state: string;
  manifest: unknown[];
  evaluation?: Record<string, unknown> | null;
  createdAt: string;
  activatedAt?: string | null;
  /** Embedded corpus chunks and where the generation stands (`building` covers several phases). */
  chunks?: number;
  embeddedChunks?: number;
  phase?: string;
};
const PHASE_HINT: Record<string, string> = {
  embedding: "Embeddings are missing; build the next batch.",
  ready_for_evaluation:
    "All chunks are embedded. Run the live evaluation next.",
  evaluation_failed:
    "The last evaluation did not pass; see its record, then evaluate again.",
  corpus_changed:
    "The knowledge changed after this generation was prepared. Prepare a new generation.",
};
export function IndexManagement() {
  const { project, revision, isOwner, refresh } = useWorkspace();
  const indexes = useResource<{ items: IndexGeneration[] }>(
    collectionPath(project.id, `indexes?revision=${revision}`),
  );
  const [mode, setMode] = useState<
    "begin" | "build" | "evaluate" | "activate" | "rollback" | null
  >(null);
  const [selected, setSelected] = useState<IndexGeneration | null>(null);
  const mutation = useMutation(() => {
    refresh();
    indexes.refresh();
  });
  return (
    <section className="panel administration-panel">
      <div className="panel-head">
        <div>
          <h2>Embedding index generations</h2>
          <p>
            A replacement is built and evaluated before activation. Existing
            generation history is retained.
          </p>
        </div>
        {isOwner && (
          <Button
            variant="outline"
            onClick={() => {
              setSelected(null);
              setMode("begin");
              mutation.clear();
            }}
          >
            Prepare index generation
          </Button>
        )}
      </div>
      <ResourceError error={indexes.error} retry={indexes.refresh} />
      {indexes.loading ? (
        <Loading />
      ) : (
        (indexes.data?.items || []).map((i) => (
          <div className="data-row index-generation" key={i.id}>
            <div>
              <strong>Generation {i.generation}</strong>
              <p>{i.profile}</p>
              <small>
                {i.embeddedChunks !== undefined
                  ? `${i.embeddedChunks} of ${i.chunks ?? 0} corpus chunks embedded`
                  : `${Array.isArray(i.manifest) ? i.manifest.length : 0} corpus chunks`}
              </small>
              {i.phase && PHASE_HINT[i.phase] && <p>{PHASE_HINT[i.phase]}</p>}
            </div>
            <Status value={i.phase ?? i.state} />
            {isOwner && (
              <div className="form-actions">
                {(i.phase === "corpus_changed"
                  ? []
                  : i.state === "building"
                    ? i.phase === "embedding"
                      ? (["build"] as const)
                      : i.phase
                        ? (["evaluate"] as const)
                        : (["build", "evaluate"] as const)
                    : i.state === "evaluated"
                      ? (["activate"] as const)
                      : i.state === "retired"
                        ? (["rollback"] as const)
                        : []
                ).map((m) => (
                  <Button
                    key={m}
                    variant="outline"
                    onClick={() => {
                      setSelected(i);
                      setMode(m);
                      mutation.clear();
                    }}
                  >
                    {m === "build"
                      ? "Build next batch"
                      : m === "evaluate"
                        ? "Evaluate"
                        : m === "activate"
                          ? "Activate"
                          : "Roll back"}
                  </Button>
                ))}
              </div>
            )}
            {i.evaluation && (
              <details>
                <summary>Evaluation record</summary>
                <pre className="code-block">
                  {JSON.stringify(i.evaluation, null, 2)}
                </pre>
              </details>
            )}
          </div>
        ))
      )}
      {mode && (
        <Modal
          title={
            mode === "begin"
              ? "Prepare index generation"
              : `${mode.charAt(0).toUpperCase() + mode.slice(1)} index generation ${selected?.generation}`
          }
          onClose={() => setMode(null)}
        >
          {(mode === "build" || mode === "evaluate") && (
            <Alert kind="warning">
              This queues paid model work when the worker and policy permit it.
              Authorized source chunks or evaluation queries are transmitted to
              OpenAI. Budget, current source rights and server configuration
              remain enforced.
            </Alert>
          )}
          {(mode === "activate" || mode === "rollback") && (
            <Alert>
              Activation changes retrieval for this project. The server requires
              a current corpus and passing evaluation; stale dependent content
              must be reviewed again.
            </Alert>
          )}
          <DataForm
            key={`${mode}-${selected?.id || "new"}`}
            fields={
              mode === "begin"
                ? [
                    {
                      name: "profile",
                      label: "Embedding profile",
                      type: "select",
                      required: true,
                      value: "openai:text-embedding-3-small:1536:chunk-v1",
                      options: options([
                        "openai:text-embedding-3-small:1536:chunk-v1",
                        "openai:text-embedding-3-large:1536:chunk-v1",
                        "openai:text-embedding-3-large:3072:chunk-v1",
                      ]),
                    },
                  ]
                : mode === "evaluate"
                  ? [
                      {
                        name: "datasetVersion",
                        label: "Evaluation dataset version",
                        required: true,
                        max: 120,
                      },
                      {
                        name: "cases",
                        label: "Evaluation cases (JSON array)",
                        type: "textarea",
                        required: true,
                        hint: "60–120 labeled cases, including at least 48 expected-evidence and 12 negative cases. Each case: id, query, expectedChunkIds, forbiddenChunkIds, language (en/de), purpose (public/internal), optional ISO at for historical validity checks.",
                      },
                      {
                        name: "confirm",
                        label:
                          "I authorize paid evaluation and transmission of these queries to OpenAI",
                        type: "checkbox",
                        required: true,
                      },
                    ]
                  : [
                      {
                        name: "confirm",
                        label:
                          mode === "build"
                            ? "I authorize this paid embedding batch for the eligible corpus"
                            : "I confirm this index generation change",
                        type: "checkbox",
                        required: true,
                      },
                    ]
            }
            pending={mutation.pending}
            error={mutation.error}
            submitLabel={
              mode === "begin"
                ? "Prepare without model call"
                : mode === "build"
                  ? "Queue embedding batch"
                  : mode === "evaluate"
                    ? "Queue paid evaluation"
                    : "Apply generation change"
            }
            onSubmit={(v) =>
              mutation
                .run(async () => {
                  if (mode === "begin")
                    return action(project.id, "begin-index", {
                      profile: str(v, "profile"),
                    });
                  if (!selected) throw new Error("Select an index generation.");
                  if (mode === "evaluate") {
                    let cases: unknown;
                    try {
                      cases = JSON.parse(str(v, "cases"));
                    } catch {
                      throw new Error("Evaluation cases must be valid JSON.");
                    }
                    if (!Array.isArray(cases))
                      throw new Error("Evaluation cases must be an array.");
                    return action(project.id, "evaluate-index", {
                      indexId: selected.id,
                      datasetVersion: str(v, "datasetVersion"),
                      cases,
                      confirmQueriesMayBeSentToOpenAI: true,
                    });
                  }
                  return action(project.id, `${mode}-index`, {
                    indexId: selected.id,
                  });
                })
                .then((r) => {
                  if (r) setMode(null);
                })
            }
          />
        </Modal>
      )}
    </section>
  );
}
