"use client";
// The versioned operating policy editor (WP2.3b), moved unchanged from components/management.tsx.
import { collectionPath, post, useMutation, value } from "@/lib/api";
import { Modal } from "@/components/ui/primitives";
import {
  DataForm,
  csv,
  dateField,
  iso,
  num,
  options,
  str,
  type FormField,
} from "@/platform/ui/form";
import { useWorkspace } from "@/components/workspace-context";
export function PolicyEditor({ onClose }: { onClose: () => void }) {
  const { project, t, refresh } = useWorkspace();
  const mutation = useMutation(() => {
    refresh();
    onClose();
  });
  const fields: FormField[] = [
    {
      name: "mode",
      label: "Operating mode",
      type: "select",
      value: "observe",
      options: options(["observe", "assisted", "autopilot"]),
    },
    {
      name: "channels",
      label: "Authorized channels (comma separated)",
      required: true,
    },
    {
      name: "contentTypes",
      label: "Authorized content types (comma separated)",
      required: true,
      placeholder: "social, blog",
    },
    {
      name: "allowedOrigins",
      label: "Approved target origins (comma separated)",
      placeholder: "https://example.com",
    },
    dateField("startAt", "Mandate start"),
    dateField("endAt", "Mandate end"),
    {
      name: "maxPerDay",
      label: "Maximum publications per day",
      type: "number",
      min: 0,
      max: 20,
      required: true,
    },
    {
      name: "minIntervalMinutes",
      label: "Minimum spacing (minutes)",
      type: "number",
      min: 1,
      max: 1440,
      required: true,
    },
    {
      name: "dailyBudget",
      label: "Daily budget (USD)",
      type: "number",
      min: 0,
      step: "0.01",
      required: true,
    },
    {
      name: "monthlyBudget",
      label: "Monthly budget (USD)",
      type: "number",
      min: 0,
      step: "0.01",
      required: true,
    },
    {
      name: "perRunBudget",
      label: "Per-run budget (USD)",
      type: "number",
      min: 0,
      step: "0.01",
      required: true,
    },
    {
      name: "quietStart",
      label: "Quiet hours start (project hour 0–23)",
      type: "number",
      min: 0,
      max: 23,
    },
    {
      name: "quietEnd",
      label: "Quiet hours end (project hour 0–23)",
      type: "number",
      min: 0,
      max: 23,
    },
    {
      name: "approvedPaidTests",
      label: "Authorize paid test calls within these exact limits",
      type: "checkbox",
    },
    {
      name: "confirm",
      label:
        "I approve this exact version, its channels, dates and cost limits.",
      type: "checkbox",
      required: true,
    },
  ];
  return (
    <Modal
      title="New operating policy"
      description="Only a verified capability can act under this mandate. Infrastructure, new spending permissions and unrelated channels remain outside its scope."
      onClose={onClose}
    >
      <DataForm
        fields={fields}
        pending={mutation.pending}
        error={mutation.error}
        t={t}
        submitLabel="Save policy version"
        onCancel={onClose}
        onSubmit={(v) =>
          mutation
            .run(() =>
              post(collectionPath(project.id, "policies"), {
                mode: str(v, "mode"),
                channels: csv(v, "channels"),
                contentTypes: csv(v, "contentTypes"),
                allowedOrigins: csv(v, "allowedOrigins"),
                startAt: iso(v, "startAt"),
                endAt: iso(v, "endAt"),
                maxPerDay: num(v, "maxPerDay"),
                minIntervalMinutes: num(v, "minIntervalMinutes"),
                dailyBudgetMicros: Math.round(
                  num(v, "dailyBudget") * 1_000_000,
                ),
                monthlyBudgetMicros: Math.round(
                  num(v, "monthlyBudget") * 1_000_000,
                ),
                perRunBudgetMicros: Math.round(
                  num(v, "perRunBudget") * 1_000_000,
                ),
                approvedPaidTests: v.approvedPaidTests === true,
                ...(str(v, "quietStart")
                  ? { quietStart: num(v, "quietStart") }
                  : {}),
                ...(str(v, "quietEnd") ? { quietEnd: num(v, "quietEnd") } : {}),
              }),
            )
            .then(() => {})
        }
      />
    </Modal>
  );
}
