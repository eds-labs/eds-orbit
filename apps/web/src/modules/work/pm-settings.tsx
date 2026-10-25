"use client";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useMutation, useResource } from "@/lib/api";
import { Alert, Button, Input, Loading } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { ResourceError } from "@/platform/ui/collection";
import { send, workPath } from "./api";
import { usePmStatus } from "./pm";
import { pmText } from "./pm-labels";
import { useWorkAccess } from "./shared";

// The AI project manager's settings (ADR 0017, plan §5): autonomy, the daily
// AI budget, the coding budget and limits, and the repositories coding
// agents may work in. Owners change them (work.pm.manage); editors read.

type Repository = {
  key: string;
  label: string;
  provider: "github";
  fullName: string;
  defaultBranch: string;
  dispatch: { kind: "manual" } | { kind: "automation"; bindingId: string };
};
type PmSettings = {
  autonomy: "propose" | "comment_only";
  dailyCeilingMicros: number;
  codingMonthlyCeilingMicros: number;
  codingMaxConcurrent: number;
  codingTimeoutHours: number;
  repositories: Repository[];
};

const toUsd = (micros: number) => String(micros / 1_000_000);
const toMicros = (usd: string) => Math.max(0, Math.round(Number(usd || 0) * 1_000_000));

function PmSettingsForm() {
  const { project, locale } = useWorkspace();
  const t = pmText(locale).settings;
  const access = useWorkAccess();
  const settings = useResource<{ settings: PmSettings; version: number }>(workPath(project.id, "/pm/settings"));
  const [draft, setDraft] = useState<PmSettings | null>(null);
  useEffect(() => {
    if (settings.data) setDraft(structuredClone(settings.data.settings));
  }, [settings.data]);
  const mutation = useMutation(settings.refresh);
  if (settings.loading && !draft) return <Loading />;
  if (settings.error) return <ResourceError error={settings.error} retry={settings.refresh} />;
  if (!draft) return null;
  const update = (patch: Partial<PmSettings>) => setDraft({ ...draft, ...patch });
  const setRepo = (index: number, patch: Partial<Repository>) =>
    update({ repositories: draft.repositories.map((r, i) => (i === index ? ({ ...r, ...patch } as Repository) : r)) });
  return (
    <form
      className="settings-form work-stack"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.run(() => send(workPath(project.id, "/pm/settings"), "PUT", { settings: draft, version: settings.data!.version }));
      }}
    >
      <fieldset disabled={!access.owner || mutation.pending} className="work-stack">
        <legend>{t.title}</legend>
        <p className="support-muted">{t.intro}</p>
        {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
        <label>
          {t.autonomy}{" "}
          <select value={draft.autonomy} onChange={(e) => update({ autonomy: e.target.value as PmSettings["autonomy"] })}>
            {Object.entries(t.autonomies).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t.dailyBudget}
          <Input type="number" min={0} step="0.01" value={toUsd(draft.dailyCeilingMicros)} onChange={(e) => update({ dailyCeilingMicros: toMicros(e.target.value) })} />
        </label>
        <label>
          {t.codingBudget}
          <Input type="number" min={0} step="0.01" value={toUsd(draft.codingMonthlyCeilingMicros)} onChange={(e) => update({ codingMonthlyCeilingMicros: toMicros(e.target.value) })} />
        </label>
        <label>
          {t.concurrency}
          <Input type="number" min={1} max={10} value={draft.codingMaxConcurrent} onChange={(e) => update({ codingMaxConcurrent: Number(e.target.value) })} />
        </label>
        <label>
          {t.timeout}
          <Input type="number" min={1} max={168} value={draft.codingTimeoutHours} onChange={(e) => update({ codingTimeoutHours: Number(e.target.value) })} />
        </label>
        <fieldset className="work-stack">
          <legend>{t.repositories}</legend>
          <ul className="settings-rows">
            {draft.repositories.map((r, i) => (
              <li key={i} className="work-settings-row">
                <Input aria-label={t.key} placeholder={t.key} value={r.key} onChange={(e) => setRepo(i, { key: e.target.value })} />
                <Input aria-label={t.label} placeholder={t.label} value={r.label} onChange={(e) => setRepo(i, { label: e.target.value })} />
                <Input aria-label={t.fullName} placeholder={t.fullName} value={r.fullName} onChange={(e) => setRepo(i, { fullName: e.target.value })} />
                <Input aria-label={t.branch} placeholder={t.branch} value={r.defaultBranch} onChange={(e) => setRepo(i, { defaultBranch: e.target.value })} />
                <select
                  aria-label={t.dispatch}
                  value={r.dispatch.kind}
                  onChange={(e) => setRepo(i, { dispatch: e.target.value === "manual" ? { kind: "manual" } : { kind: "automation", bindingId: "" } })}
                >
                  <option value="manual">{t.manual}</option>
                  <option value="automation">{t.automation}</option>
                </select>
                {r.dispatch.kind === "automation" && (
                  <Input
                    aria-label={t.bindingId}
                    placeholder={t.bindingId}
                    value={r.dispatch.bindingId}
                    onChange={(e) => setRepo(i, { dispatch: { kind: "automation", bindingId: e.target.value.trim() } })}
                  />
                )}
                <Button type="button" variant="ghost" size="sm" aria-label="×" onClick={() => update({ repositories: draft.repositories.filter((_, j) => j !== i) })}>
                  <X aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              update({
                repositories: [
                  ...draft.repositories,
                  { key: `repo${draft.repositories.length + 1}`, label: "", provider: "github", fullName: "", defaultBranch: "main", dispatch: { kind: "manual" } },
                ],
              })
            }
          >
            {t.addRepository}
          </Button>
        </fieldset>
        {access.owner && (
          <div className="form-actions">
            <Button type="submit">{t.save}</Button>
          </div>
        )}
      </fieldset>
    </form>
  );
}

/** Shown while the PM runs here, to members who may use it. */
export function usePmSettingsSection() {
  const status = usePmStatus();
  const access = useWorkAccess();
  if (!status.data?.available || !access.write) return null;
  return { content: <PmSettingsForm /> };
}
