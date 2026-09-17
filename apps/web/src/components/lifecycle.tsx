"use client";
import { useState } from "react";
import { action, type Entity } from "@/lib/api";
import { useMutation } from "@/lib/api";
import { Alert, Button, Modal } from "./ui/primitives";
import {
  DataForm,
  str,
  num,
  iso,
  dateField,
  options,
  type FormField,
} from "./form";
import { useWorkspace } from "./workspace-context";
export function ExperimentControls({
  entity,
  onUpdate,
}: {
  entity: Entity;
  onUpdate: (e: Entity) => void;
}) {
  const { project, isOwner, canEdit, refresh } = useWorkspace();
  const mutation = useMutation(refresh);
  const [stopping, setStopping] = useState(false);
  return (
    <>
      <div className="form-actions">
        {canEdit && (
          <Button
            disabled={mutation.pending}
            onClick={() =>
              mutation
                .run(() =>
                  action<Entity>(project.id, "evaluate-experiment", {
                    experimentId: entity.id,
                  }),
                )
                .then((e) => {
                  if (e) onUpdate(e);
                })
            }
          >
            Evaluate actual measurements
          </Button>
        )}
        {isOwner &&
          !["stopped", "completed"].includes(String(entity.data.status)) && (
            <Button variant="outline" onClick={() => setStopping(!stopping)}>
              Stop experiment
            </Button>
          )}
      </div>
      {stopping && (
        <DataForm
          fields={[
            {
              name: "reason",
              label: "Reason for stopping",
              type: "textarea",
              required: true,
              min: 5,
              max: 500,
            },
          ]}
          pending={mutation.pending}
          error={mutation.error}
          submitLabel="Confirm stop"
          onCancel={() => setStopping(false)}
          onSubmit={(v) =>
            mutation
              .run(() =>
                action<Entity>(project.id, "stop-experiment", {
                  experimentId: entity.id,
                  version: entity.version,
                  reason: str(v, "reason"),
                }),
              )
              .then((e) => {
                if (e) {
                  onUpdate(e);
                  setStopping(false);
                }
              })
          }
        />
      )}
      {!stopping && mutation.error && (
        <Alert kind="error">{mutation.error}</Alert>
      )}
    </>
  );
}
export function MemoryLifecycleControls({
  entity,
  onDone,
}: {
  entity: Entity;
  onDone: () => void;
}) {
  const { project, isOwner, refresh } = useWorkspace();
  const mutation = useMutation(() => {
    refresh();
    onDone();
  });
  const [operation, setOperation] = useState<"disable" | "delete" | null>(null);
  if (!isOwner || entity.data.status === "deleted") return null;
  return (
    <>
      <div className="form-actions">
        <Button
          variant="outline"
          disabled={entity.data.status === "disabled"}
          onClick={() => setOperation("disable")}
        >
          Disable this memory
        </Button>
        <Button variant="destructive" onClick={() => setOperation("delete")}>
          Delete this memory
        </Button>
      </div>
      {operation && (
        <>
          <Alert kind={operation === "delete" ? "warning" : "info"}>
            {operation === "delete"
              ? "This removes the record text and its previous versions. An audit identifier remains."
              : "Disabled memory is excluded from future planning."}
          </Alert>
          <DataForm
            fields={[
              {
                name: "confirm",
                label: `I confirm ${operation === "delete" ? "deleting" : "disabling"} this exact memory record, version ${entity.version}.`,
                type: "checkbox",
                required: true,
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel={
              operation === "delete" ? "Confirm deletion" : "Confirm disabling"
            }
            onCancel={() => setOperation(null)}
            onSubmit={() =>
              mutation
                .run(() =>
                  action(project.id, "memory-lifecycle", {
                    kind: entity.kind,
                    id: entity.id,
                    version: entity.version,
                    operation,
                  }),
                )
                .then(() => {})
            }
          />
        </>
      )}
    </>
  );
}
export function RetentionControl() {
  const { project, isOwner, refresh } = useWorkspace();
  const [open, setOpen] = useState(false);
  const mutation = useMutation(refresh);
  if (!isOwner) return null;
  return (
    <section className="panel administration-panel">
      <div className="panel-head">
        <div>
          <h2>Memory retention</h2>
          <p>
            Delete old insights and expired editorial preferences within this
            project.
          </p>
        </div>
        <Button variant="outline" onClick={() => setOpen(true)}>
          Review retention
        </Button>
      </div>
      {open && (
        <Modal
          title="Apply memory retention"
          description="This is a deletion action. It removes record text and previous versions, while keeping the audit identifier. Source documents and product facts are managed separately."
          onClose={() => setOpen(false)}
        >
          <DataForm
            fields={[
              {
                name: "days",
                label: "Retain the last number of days",
                type: "number",
                required: true,
                min: 30,
                max: 3650,
              },
              {
                name: "confirm",
                label:
                  "I approve deleting older insights and expired preferences using this exact retention period.",
                type: "checkbox",
                required: true,
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel="Apply retention deletion"
            onCancel={() => setOpen(false)}
            onSubmit={(v) =>
              mutation
                .run(() =>
                  action(project.id, "retention", { days: num(v, "days") }),
                )
                .then((r) => {
                  if (r) setOpen(false);
                })
            }
          />
        </Modal>
      )}
      {mutation.success && (
        <Alert kind="success">
          The retention operation was recorded for this project.
        </Alert>
      )}
    </section>
  );
}
export function MetricCorrection({
  entity,
  onDone,
}: {
  entity: Entity;
  onDone: () => void;
}) {
  const { project, isOwner, refresh } = useWorkspace();
  const mutation = useMutation(() => {
    refresh();
    onDone();
  });
  const [editing, setEditing] = useState(false);
  const d = entity.data;
  const toLocal = (v: unknown) =>
    typeof v === "string"
      ? new Date(Date.parse(v) - new Date(v).getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16)
      : "";
  const fields: FormField[] = [
    {
      name: "source",
      label: "Source",
      type: "select",
      value: String(d.source || "csv"),
      options: options(["csv", "matomo", "postiz", "manual_test"]),
    },
    {
      name: "externalId",
      label: "Stable source record ID",
      value: String(d.externalId || ""),
      required: true,
    },
    {
      name: "campaign",
      label: "Campaign",
      value: String(d.campaign || ""),
      required: true,
    },
    {
      ...dateField("periodStart", "Period start"),
      value: toLocal(d.periodStart),
    },
    { ...dateField("periodEnd", "Period end"), value: toLocal(d.periodEnd) },
    {
      name: "timezone",
      label: "Source timezone",
      value: String(d.timezone || project.timezone),
      required: true,
    },
    {
      name: "currency",
      label: "Currency",
      value: String(d.currency || ""),
      required: true,
    },
    ...["impressions", "clicks", "sessions", "conversions"].map((name) => ({
      name,
      label: name,
      type: "number" as const,
      min: 0,
      value: d[name] === null ? "" : String(d[name] ?? ""),
    })),
    {
      name: "cost",
      label: "Measured spend",
      type: "number",
      min: 0,
      step: "0.000001",
      value:
        d.costMicros === null ? "" : String(Number(d.costMicros || 0) / 1e6),
    },
    {
      name: "sampleSize",
      label: "Sample size",
      type: "number",
      min: 0,
      value: String(d.sampleSize ?? ""),
      required: true,
    },
    {
      name: "synthetic",
      label: "Synthetic test data",
      type: "checkbox",
      value: d.synthetic === true,
    },
    {
      name: "reason",
      label: "Reason for correcting measurements",
      type: "textarea",
      min: 5,
      max: 500,
      required: true,
    },
  ];
  return isOwner ? (
    <>
      <div className="form-actions">
        <Button variant="outline" onClick={() => setEditing(!editing)}>
          Correct measurements
        </Button>
      </div>
      {editing && (
        <>
          <Alert>
            Corrections version the measurement and invalidate derived insights.
            Run analysis again after reviewing the corrected data.
          </Alert>
          <DataForm
            fields={fields}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel="Save corrected version"
            onCancel={() => setEditing(false)}
            onSubmit={(v) =>
              mutation
                .run(() =>
                  action(project.id, "correct-metric", {
                    metricId: entity.id,
                    version: entity.version,
                    reason: str(v, "reason"),
                    values: {
                      source: str(v, "source"),
                      externalId: str(v, "externalId"),
                      campaign: str(v, "campaign"),
                      periodStart: iso(v, "periodStart"),
                      periodEnd: iso(v, "periodEnd"),
                      timezone: str(v, "timezone"),
                      currency: str(v, "currency"),
                      ...Object.fromEntries(
                        [
                          "impressions",
                          "clicks",
                          "sessions",
                          "conversions",
                        ].map((k) => [k, str(v, k) ? num(v, k) : null]),
                      ),
                      costMicros: str(v, "cost")
                        ? Math.round(num(v, "cost") * 1e6)
                        : null,
                      sampleSize: num(v, "sampleSize"),
                      synthetic: v.synthetic === true,
                    },
                  }),
                )
                .then(() => {})
            }
          />
        </>
      )}
    </>
  ) : null;
}
