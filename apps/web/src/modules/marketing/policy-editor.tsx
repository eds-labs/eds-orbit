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
  str,
  type FormField,
} from "@/platform/ui/form";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { modeLabel } from "@/lib/i18n";
import { activationErrorText } from "@/lib/readiness-text";
import { marketingText } from "./labels";
type SpendLimits = {
  startAt: string;
  endAt: string;
  approvedPaidTests: boolean;
  dailyBudgetMicros: number;
  monthlyBudgetMicros: number;
  perRunBudgetMicros: number;
};

export function PolicyEditor({ onClose }: { onClose: () => void }) {
  const { project, locale, t, refresh } = useWorkspace();
  const shell = useShell();
  const words = marketingText(locale).editor;
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
      label: words.mode,
      type: "select",
      value: "observe",
      options: ["observe", "assisted", "autopilot"].map((mode) => ({
        value: mode,
        label: modeLabel(mode, t),
      })),
    },
    {
      name: "channels",
      label: words.channels,
      required: true,
    },
    {
      name: "contentTypes",
      label: words.contentTypes,
      required: true,
      placeholder: "social, blog",
    },
    {
      name: "allowedOrigins",
      label: words.allowedOrigins,
      placeholder: "https://example.com",
    },
    dateField("startAt", words.startAt),
    dateField("endAt", words.endAt),
    {
      name: "maxPerDay",
      label: words.maxPerDay,
      type: "number",
      min: 0,
      max: 20,
      required: true,
    },
    {
      name: "minIntervalMinutes",
      label: words.minInterval,
      type: "number",
      min: 1,
      max: 1440,
      required: true,
    },
    {
      name: "quietStart",
      label: words.quietStart,
      type: "number",
      min: 0,
      max: 23,
    },
    {
      name: "quietEnd",
      label: words.quietEnd,
      type: "number",
      min: 0,
      max: 23,
    },
    {
      name: "confirm",
      label: words.confirm,
      type: "checkbox",
      required: true,
    },
  ];
  return (
    <Modal
      title={words.title}
      description={words.description}
      onClose={onClose}
    >
      <Alert>
        {words.budgetPrefix}{" "}
        {limits
          ? `${words.budgetLimits(
              usd(limits.dailyBudgetMicros),
              usd(limits.monthlyBudgetMicros),
              usd(limits.perRunBudgetMicros),
              when(limits.endAt, locale, project.timezone),
            )}${limits.approvedPaidTests ? "" : words.budgetUnpaid}. `
          : `${words.budgetNotSet} `}
        {words.budgetScope}{" "}
        <AppLink href={shell.projectCenterHref("ai")}>{words.budgetLink}</AppLink>
        {words.budgetKept}
      </Alert>
      <DataForm
        fields={fields}
        pending={mutation.pending || spend.loading}
        error={activationErrorText(locale, mutation.error)}
        t={t}
        submitLabel={words.save}
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
