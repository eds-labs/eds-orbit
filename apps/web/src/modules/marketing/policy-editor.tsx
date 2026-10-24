"use client";
// The versioned operating policy editor (WP2.3b), moved from
// components/management.tsx. Since ADR 0015 the AI budget is the platform's
// spending authority (Settings → AI & budget): the editor no longer edits
// it and saves the effective limits unchanged, so the policy's copy stays
// in line with what calls are reserved against.
import {
  collectionPath,
  post,
  useMutation,
  useResource,
  usd,
  value,
  when,
} from "@/lib/api";
import { Alert, Modal } from "@/components/ui/primitives";
import { AppLink } from "@/platform/ui/app-link";
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
type SpendLimits = {
  startAt: string;
  endAt: string;
  approvedPaidTests: boolean;
  dailyBudgetMicros: number;
  monthlyBudgetMicros: number;
  perRunBudgetMicros: number;
};

export function PolicyEditor({ onClose }: { onClose: () => void }) {
  const { project, t, refresh } = useWorkspace();
  const mutation = useMutation(() => {
    refresh();
    onClose();
  });
  const spend = useResource<{ effective: SpendLimits | null }>(
    collectionPath(project.id, "ai-spend-policy"),
  );
  // Without a spending authority the policy grants no paid AI.
  const limits = spend.data?.effective;
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
      name: "confirm",
      label:
        "I approve this exact version, its channels and dates.",
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
      <Alert>
        AI budget:{" "}
        {limits
          ? `${usd(limits.dailyBudgetMicros)} per day, ${usd(limits.monthlyBudgetMicros)} per month, ${usd(limits.perRunBudgetMicros)} per run, until ${when(limits.endAt)}${limits.approvedPaidTests ? "" : " (paid use not allowed)"}. `
          : "not set, so no paid AI runs. "}
        It applies to every module and is set under{" "}
        <AppLink href="/settings?section=ai">Settings → AI &amp; budget</AppLink>
        ; this policy keeps it unchanged.
      </Alert>
      <DataForm
        fields={fields}
        pending={mutation.pending || spend.loading}
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
                // The effective spending authority, unchanged (ADR 0015).
                dailyBudgetMicros: limits?.dailyBudgetMicros ?? 0,
                monthlyBudgetMicros: limits?.monthlyBudgetMicros ?? 0,
                perRunBudgetMicros: limits?.perRunBudgetMicros ?? 0,
                approvedPaidTests: limits?.approvedPaidTests ?? false,
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
