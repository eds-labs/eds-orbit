"use client";
import { useState } from "react";
import {
  action,
  collectionPath,
  post,
  useMutation,
  useResource,
  value,
  when,
  type Entity,
} from "@/lib/api";
import { Alert, Badge, Button, Loading, Modal, Status } from "./ui/primitives";
import { DataForm, num, options, str } from "./form";
import { useWorkspace } from "./workspace-context";
import { ResourceError, useCollection } from "./work";

export function MatomoImport() {
  const { project, isOwner, refresh } = useWorkspace();
  const connectors = useCollection("connectors");
  const [open, setOpen] = useState(false);
  const mutation = useMutation(refresh);
  const available = (connectors.data?.items || []).filter(
    (c) => c.data.provider === "matomo" && c.data.status !== "revoked",
  );
  if (!isOwner) return null;
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Import from Matomo
      </Button>
      {open && (
        <Modal
          title="Import from Matomo"
          description="An authenticated, aggregate-only read from your configured Matomo instance. Raw visitors, user IDs and search terms are not imported."
          onClose={() => setOpen(false)}
        >
          <ResourceError error={connectors.error} retry={connectors.refresh} />
          {!available.length ? (
            <Alert kind="warning">
              Configure a Matomo connector first. Existing CSV and manual
              measurements remain available.
            </Alert>
          ) : (
            <DataForm
              fields={[
                {
                  name: "connectorId",
                  label: "Matomo connection",
                  type: "select",
                  required: true,
                  options: available.map((c) => ({
                    value: c.id,
                    label: String(c.data.baseUrl || c.id),
                  })),
                },
                {
                  name: "siteId",
                  label: "Matomo site ID",
                  type: "number",
                  required: true,
                  min: 1,
                },
                {
                  name: "date",
                  label: "Report date (YYYY-MM-DD)",
                  required: true,
                  max: 10,
                  placeholder: "2026-09-01",
                },
                {
                  name: "siteTimezone",
                  label: "Matomo site timezone",
                  value: project.timezone,
                  required: true,
                  hint: "Must match the reporting site's timezone.",
                },
                {
                  name: "currency",
                  label: "Reporting currency (ISO code)",
                  required: true,
                  value: "EUR",
                  max: 3,
                },
                {
                  name: "method",
                  label: "Aggregate report",
                  type: "select",
                  required: true,
                  value: "VisitsSummary.get",
                  options: options([
                    "VisitsSummary.get",
                    "Referrers.getCampaigns",
                    "Actions.getPageUrls",
                    "Goals.get",
                  ]),
                },
                {
                  name: "goalId",
                  label: "Goal ID (optional)",
                  type: "number",
                  min: 1,
                  showWhen: { name: "method", values: ["Goals.get"] },
                },
                {
                  name: "confirm",
                  label:
                    "Read this aggregate report from the configured instance",
                  type: "checkbox",
                  required: true,
                },
              ]}
              pending={mutation.pending}
              error={mutation.error}
              submitLabel="Read and import report"
              onSubmit={(v) =>
                mutation
                  .run(() =>
                    action(project.id, "import-matomo", {
                      connectorId: str(v, "connectorId"),
                      siteId: num(v, "siteId"),
                      date: str(v, "date"),
                      siteTimezone: str(v, "siteTimezone"),
                      currency: str(v, "currency").toUpperCase(),
                      method: str(v, "method"),
                      ...(str(v, "goalId") ? { goalId: num(v, "goalId") } : {}),
                    }),
                  )
                  .then((r) => {
                    if (r) setOpen(false);
                  })
              }
            />
          )}
        </Modal>
      )}
    </>
  );
}

type IndexGeneration = {
  id: string;
  generation: number;
  profile: string;
  state: string;
  manifest: unknown[];
  evaluation?: Record<string, unknown> | null;
  createdAt: string;
  activatedAt?: string | null;
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
                {Array.isArray(i.manifest) ? i.manifest.length : 0} corpus
                chunks
              </small>
            </div>
            <Status value={i.state} />
            {isOwner && (
              <div className="form-actions">
                {(i.state === "building"
                  ? (["build", "evaluate", "activate"] as const)
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
                        hint: "60–120 labeled cases, including at least 48 expected-evidence and 12 negative cases. Each case: id, query, expectedChunkIds, forbiddenChunkIds, language (en/de), purpose (public/internal).",
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

export function WorkspacePause() {
  const { project, identity, isOwner, refresh } = useWorkspace();
  const [open, setOpen] = useState(false);
  const mutation = useMutation(refresh);
  const workspace = identity.workspaces.find(
    (w) => w.id === project.workspaceId,
  );
  if (!isOwner || workspace?.role !== "owner") return null;
  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setOpen(true);
          mutation.clear();
        }}
      >
        Workspace execution
      </Button>
      {open && (
        <Modal
          title="Workspace execution"
          description={`This affects every project in ${workspace.name}. Queued work rechecks the current policy and source rights.`}
          onClose={() => setOpen(false)}
        >
          <DataForm
            fields={[
              {
                name: "paused",
                label: "Workspace action",
                type: "select",
                required: true,
                options: [
                  { value: "true", label: "Pause all workspace projects" },
                  { value: "false", label: "Resume all workspace projects" },
                ],
              },
              {
                name: "confirm",
                label: "Apply this action to every project in this workspace",
                type: "checkbox",
                required: true,
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel="Apply workspace action"
            onSubmit={(v) =>
              mutation
                .run(() =>
                  post(
                    `/workspaces/${encodeURIComponent(project.workspaceId)}/pause`,
                    { paused: str(v, "paused") === "true" },
                  ),
                )
                .then((r) => {
                  if (r) setOpen(false);
                })
            }
          />
        </Modal>
      )}
    </>
  );
}

export function FactWithdrawal({
  entity,
  onDone,
}: {
  entity: Entity;
  onDone: () => void;
}) {
  const { project, isOwner, refresh } = useWorkspace();
  const [confirm, setConfirm] = useState(false);
  const mutation = useMutation(() => {
    refresh();
    onDone();
  });
  if (
    !isOwner ||
    ["revoked", "withdrawn", "superseded"].includes(String(entity.data.status))
  )
    return null;
  return (
    <div>
      {!confirm ? (
        <Button variant="outline" onClick={() => setConfirm(true)}>
          Withdraw fact
        </Button>
      ) : (
        <>
          <Alert kind="warning">
            Withdraw this exact fact version and invalidate dependent evidence
            and content. The history remains available.
          </Alert>
          <DataForm
            fields={[
              {
                name: "confirm",
                label: "Withdraw this fact from future use",
                type: "checkbox",
                required: true,
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel="Withdraw version"
            onCancel={() => setConfirm(false)}
            onSubmit={() =>
              mutation
                .run(() =>
                  action(project.id, "withdraw-fact", {
                    factId: entity.id,
                    version: entity.version,
                  }),
                )
                .then(() => {})
            }
          />
        </>
      )}
    </div>
  );
}

export function PostizVerification({ connector }: { connector: Entity }) {
  const { project, isOwner, locale, refresh } = useWorkspace();
  const verifications = useCollection("connector_verifications");
  const assets = useCollection("assets");
  const [open, setOpen] = useState(false);
  const [packet, setPacket] = useState<Entity | null>(null);
  const mutation = useMutation(refresh);
  const accounts = (
    Array.isArray(connector.data.channels) ? connector.data.channels : []
  ).filter((a): a is Record<string, unknown> =>
    Boolean(
      a && typeof a === "object" && !(a as Record<string, unknown>).disabled,
    ),
  );
  const records = (verifications.data?.items || []).filter(
    (v) => v.data.connectorId === connector.id,
  );
  const approvedAssets = (assets.data?.items || []).filter(
    (a) =>
      a.data.mime === "image/png" &&
      a.data.usageApproved === true &&
      a.data.hasContent === true,
  );
  const packetAsset =
    packet?.data.asset && typeof packet.data.asset === "object"
      ? (packet.data.asset as Record<string, unknown>)
      : null;
  const previewAsset =
    packetAsset &&
    approvedAssets.find(
      (a) => a.id === packetAsset.assetId && a.version === packetAsset.version,
    );
  if (!isOwner) return null;
  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setOpen(true);
          setPacket(null);
          mutation.clear();
        }}
      >
        Verify sandbox write
      </Button>
      {open && (
        <Modal
          title="Postiz sandbox verification"
          description="A read check does not establish publishing capability. Prepare a concrete package, review the account and exact test content, then explicitly authorize one test write."
          onClose={() => setOpen(false)}
        >
          <ResourceError
            error={verifications.error}
            retry={verifications.refresh}
          />
          {!packet ? (
            <>
              {!["read_verified", "write_verified"].includes(
                String(connector.data.status),
              ) || !accounts.length ? (
                <Alert kind="warning">
                  Run a successful read capability check first. Only enabled
                  accounts returned by that check can be selected.
                </Alert>
              ) : (
                <DataForm
                  fields={[
                    {
                      name: "integrationId",
                      label: "Sandbox social account",
                      type: "select",
                      required: true,
                      options: accounts.map((a) => ({
                        value: String(a.id),
                        label: `${String(a.name || a.id)} · ${String(a.identifier || "")}`,
                      })),
                    },
                    {
                      name: "assetId",
                      label: "Approved PNG test asset (optional)",
                      type: "select",
                      options: approvedAssets.map((a) => ({
                        value: a.id,
                        label: `${value(a, "title", "Rendered asset")} · version ${a.version}`,
                      })),
                      hint: "A successful image proof is recorded separately from plain text publishing.",
                    },
                    {
                      name: "confirm",
                      label:
                        "This account is a sandbox account authorized for this connection test",
                      type: "checkbox",
                      required: true,
                    },
                  ]}
                  pending={mutation.pending}
                  error={mutation.error}
                  submitLabel="Prepare exact test package"
                  onSubmit={(v) =>
                    mutation
                      .run(() =>
                        action<Entity>(project.id, "postiz-test-prepare", {
                          connectorId: connector.id,
                          integrationId: str(v, "integrationId"),
                          confirmSandboxAccount: true,
                          ...(str(v, "assetId")
                            ? { assetId: str(v, "assetId") }
                            : {}),
                        }),
                      )
                      .then((r) => {
                        if (r) setPacket(r);
                      })
                  }
                />
              )}
              {records.length > 0 && (
                <section>
                  <h3>Verification history</h3>
                  {records.map((v) => (
                    <div className="data-row" key={v.id}>
                      <div>
                        <strong>{value(v, "integrationName")}</strong>
                        <Status value={v.data.status} />
                      </div>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setPacket(v);
                          mutation.clear();
                        }}
                      >
                        Inspect package
                      </Button>
                    </div>
                  ))}
                </section>
              )}
            </>
          ) : (
            <>
              <div className="detail-summary">
                <Status value={packet.data.status} />
                <Badge>
                  Connection version {value(packet, "connectorVersion")}
                </Badge>
              </div>
              <dl className="detail-grid">
                <dt>Instance</dt>
                <dd>
                  {value(packet, "baseUrl")} / {value(packet, "instanceId")}
                </dd>
                <dt>Account</dt>
                <dd>
                  {value(packet, "integrationName")} (
                  {value(packet, "integrationId")})
                </dd>
                <dt>Publication</dt>
                <dd>Immediately, after explicit approval</dd>
                <dt>Approval expires</dt>
                <dd>{when(packet.data.expiresAt, locale, project.timezone)}</dd>
                <dt>Package hash</dt>
                <dd className="break-anywhere">
                  {value(packet, "packageHash")}
                </dd>
              </dl>
              {packetAsset && (
                <section>
                  <h3>Exact test image</h3>
                  <p>
                    {String(packetAsset.width)} × {String(packetAsset.height)} ·{" "}
                    {String(packetAsset.mime)}
                  </p>
                  <p className="break-anywhere">
                    SHA-256: {String(packetAsset.hash)}
                  </p>
                  {previewAsset ? (
                    <img
                      className="creative-preview"
                      src={`/api/projects/${encodeURIComponent(project.id)}/assets/${encodeURIComponent(previewAsset.id)}/content`}
                      alt="Prepared sandbox verification asset"
                    />
                  ) : (
                    <Alert kind="warning">
                      The exact approved image version is unavailable. Refresh
                      and prepare a current package before authorizing
                      publication.
                    </Alert>
                  )}
                </section>
              )}
              <h3>Exact test text</h3>
              <blockquote className="evidence-excerpt">
                {value(packet, "body")}
              </blockquote>
              <Alert kind="warning">
                {value(packet, "cleanup")} Live mode and external-write
                configuration must also permit this action.
              </Alert>
              {packet.data.status === "prepared" &&
              (!packetAsset || previewAsset) ? (
                <DataForm
                  key={packet.id}
                  fields={[
                    {
                      name: "confirm",
                      label:
                        "Publish this exact text and any displayed image to the sandbox account now",
                      type: "checkbox",
                      required: true,
                    },
                  ]}
                  pending={mutation.pending}
                  error={mutation.error}
                  submitLabel="Publish the approved test once"
                  onSubmit={() =>
                    mutation
                      .run(() =>
                        action<Entity>(project.id, "postiz-test-execute", {
                          verificationId: packet.id,
                          packageHash: packet.data.packageHash,
                          confirmPublishExactTest: true,
                        }),
                      )
                      .then((r) => {
                        if (r) setPacket(r);
                      })
                  }
                />
              ) : (
                <>
                  <Button
                    variant="outline"
                    disabled={mutation.pending}
                    onClick={() =>
                      mutation
                        .run(() =>
                          action<Entity>(project.id, "postiz-test-reconcile", {
                            verificationId: packet.id,
                          }),
                        )
                        .then((r) => {
                          if (r) setPacket(r);
                        })
                    }
                  >
                    Read remote test outcome
                  </Button>
                  {mutation.error && (
                    <Alert kind="error">{mutation.error}</Alert>
                  )}
                </>
              )}
            </>
          )}
        </Modal>
      )}
    </>
  );
}
