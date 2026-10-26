"use client";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useMutation, useResource } from "@/lib/api";
import { Alert, Button, Input, Loading } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import type { SettingsSection } from "@/platform/shell/types";
import { ResourceError } from "@/platform/ui/collection";
import { issuesPath, send, type IssuesSettings, type Source } from "./api";
import { issuesText, type IssuesText } from "./labels";
import { useIssuesAccess, useIssuesLists } from "./shared";

// The module's settings section (plan §5): components, categories,
// duplicates, AI triage, automation, intake cap, retention, production
// environments and the inbound sources. Owners edit; others read.

const KEY = /^[a-z][a-z0-9_]{1,40}$/;
const USD = 1_000_000;

function IssuesSettingsForm() {
  const { project, locale } = useWorkspace();
  const t = issuesText(locale);
  const access = useIssuesAccess();
  const lists = useIssuesLists();
  const [draft, setDraft] = useState<IssuesSettings | null>(null);
  useEffect(() => {
    if (lists.settings) setDraft(structuredClone(lists.settings));
  }, [lists.settings]);
  const mutation = useMutation(lists.refresh);
  if (lists.loading && !draft) return <Loading />;
  if (lists.error) return <ResourceError error={lists.error} retry={lists.refresh} />;
  if (!draft) return null;
  const s = t.settings;
  const update = (next: Partial<IssuesSettings>) => setDraft({ ...draft, ...next });
  const valid =
    draft.components.every((c) => KEY.test(c.key) && c.label.en.trim() && c.label.de.trim()) &&
    draft.categories.every((c) => KEY.test(c.key) && c.label.en.trim() && c.label.de.trim()) &&
    draft.productionEnvironments.length > 0 &&
    draft.retention.diagnosticsMonths <= draft.retention.closedIssueMonths;
  const labelled = (legend: string, add: string, items: IssuesSettings["components"], onChange: (items: IssuesSettings["components"]) => void) => (
    <fieldset className="work-stack">
      <legend>{legend}</legend>
      <ul className="settings-rows">
        {items.map((item, i) => {
          const set = (next: Partial<(typeof items)[number]>) => onChange(items.map((x, j) => (j === i ? { ...x, ...next } : x)));
          return (
            <li key={i} className="work-settings-row">
              <Input aria-label={s.key} value={item.key} onChange={(e) => set({ key: e.target.value })} />
              <Input aria-label={s.labelEn} value={item.label.en} onChange={(e) => set({ label: { ...item.label, en: e.target.value } })} />
              <Input aria-label={s.labelDe} value={item.label.de} onChange={(e) => set({ label: { ...item.label, de: e.target.value } })} />
              <Button type="button" variant="ghost" size="icon" aria-label={t.cancel} onClick={() => onChange(items.filter((_, j) => j !== i))}>
                <X aria-hidden />
              </Button>
            </li>
          );
        })}
      </ul>
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...items, { key: `item_${items.length + 1}`, label: { en: "", de: "" } }])}>
        {add}
      </Button>
    </fieldset>
  );
  return (
    <form
      className="settings-form work-stack"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.run(() => send(issuesPath(project.id, "/settings"), "PUT", { settings: draft, version: lists.version }));
      }}
    >
      <fieldset disabled={!access.owner || mutation.pending} className="work-stack">
        {labelled(s.components, s.addComponent, draft.components, (components) => update({ components }))}
        {labelled(s.categories, s.addCategory, draft.categories, (categories) => update({ categories }))}
        <fieldset className="work-stack">
          <legend>{s.dedupe}</legend>
          <label className="support-check">
            <input
              type="checkbox"
              checked={draft.dedupe.autoAttachFingerprint}
              onChange={(e) => update({ dedupe: { ...draft.dedupe, autoAttachFingerprint: e.target.checked } })}
            />
            {s.autoAttach}
          </label>
          <label>
            {s.threshold}
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={draft.dedupe.suggestThreshold}
              onChange={(e) => update({ dedupe: { ...draft.dedupe, suggestThreshold: Number(e.target.value) } })}
            />
          </label>
        </fieldset>
        <fieldset className="work-stack">
          <legend>{s.triage}</legend>
          <label className="support-check">
            <input type="checkbox" checked={draft.triage.aiEnabled} onChange={(e) => update({ triage: { ...draft.triage, aiEnabled: e.target.checked } })} />
            {s.aiEnabled}
          </label>
          <label>
            {s.aiCeiling}
            <Input
              type="number"
              min={0}
              step={0.1}
              value={draft.triage.aiDailyCeilingMicros / USD}
              onChange={(e) => update({ triage: { ...draft.triage, aiDailyCeilingMicros: Math.round(Number(e.target.value) * USD) } })}
            />
          </label>
        </fieldset>
        <fieldset className="work-stack">
          <legend>{s.sync}</legend>
          <label className="support-check">
            <input type="checkbox" checked={draft.sync.autoFixReady} onChange={(e) => update({ sync: { ...draft.sync, autoFixReady: e.target.checked } })} />
            {s.autoFixReady}
          </label>
          <label className="support-check">
            <input type="checkbox" checked={draft.sync.autoRelease} disabled onChange={() => undefined} />
            {s.autoRelease}
          </label>
          <label>
            {s.cap}
            <Input
              type="number"
              min={1}
              max={10000}
              value={draft.intake.dailyReportCap}
              onChange={(e) => update({ intake: { dailyReportCap: Number(e.target.value) } })}
            />
          </label>
          <label>
            {s.production}
            <Input
              value={draft.productionEnvironments.join(", ")}
              onChange={(e) => update({ productionEnvironments: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })}
            />
          </label>
        </fieldset>
        <fieldset className="work-stack">
          <legend>{s.retention}</legend>
          <div className="support-controls">
            <label>
              {s.closedMonths}
              <Input
                type="number"
                min={1}
                max={120}
                value={draft.retention.closedIssueMonths}
                onChange={(e) => update({ retention: { ...draft.retention, closedIssueMonths: Number(e.target.value) } })}
              />
            </label>
            <label>
              {s.diagnosticsMonths}
              <Input
                type="number"
                min={1}
                max={120}
                value={draft.retention.diagnosticsMonths}
                onChange={(e) => update({ retention: { ...draft.retention, diagnosticsMonths: Number(e.target.value) } })}
              />
            </label>
          </div>
        </fieldset>
      </fieldset>
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {access.owner && (
        <Button type="submit" disabled={!valid || mutation.pending}>
          {t.save}
        </Button>
      )}
      {access.owner && <SourcesPanel t={t} />}
    </form>
  );
}

function SourcesPanel({ t }: { t: IssuesText }) {
  const { project } = useWorkspace();
  const s = t.settings;
  const sources = useResource<{ items: Source[] }>(issuesPath(project.id, "/sources"));
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"webhook" | "n8n">("n8n");
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const mutation = useMutation(sources.refresh);
  return (
    <fieldset className="work-stack">
      <legend>{s.sources}</legend>
      <p className="support-muted">{s.sourcesIntro}</p>
      {sources.error && <ResourceError error={sources.error} retry={sources.refresh} />}
      <ul className="settings-rows">
        {(sources.data?.items ?? []).map((source) => (
          <li key={source.id} className="work-settings-row">
            <span>
              {source.name} ({source.kind})
            </span>
            <code>{source.path}</code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={mutation.pending}
              onClick={() => mutation.run(() => send(issuesPath(project.id, `/sources/${encodeURIComponent(source.id)}`), "DELETE"))}
            >
              {s.disable}
            </Button>
          </li>
        ))}
      </ul>
      {secret && (
        <Alert kind="warning">
          {s.secretOnce} <strong>{secret.name}</strong>: <code>{secret.secret}</code>
        </Alert>
      )}
      <div className="work-settings-row">
        <Input aria-label={s.sourceName} placeholder={s.sourceName} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
        <select aria-label={s.sources} value={kind} onChange={(e) => setKind(e.target.value as "webhook" | "n8n")}>
          <option value="n8n">n8n</option>
          <option value="webhook">Webhook</option>
        </select>
        <Button
          type="button"
          size="sm"
          disabled={!name.trim() || mutation.pending}
          onClick={() =>
            mutation.run(async () => {
              const created = await send<Source & { secret: string }>(issuesPath(project.id, "/sources"), "POST", { name: name.trim(), kind });
              setSecret({ name: created.name, secret: created.secret });
              setName("");
            })
          }
        >
          {s.addSource}
        </Button>
      </div>
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
    </fieldset>
  );
}

function useIssuesSection() {
  return { content: <IssuesSettingsForm /> };
}

/** The module's section of the project settings. */
export const issuesSettings: readonly SettingsSection[] = [
  {
    tab: { key: "issues", label: { en: "Issues", de: "Issues" }, order: 35 },
    order: 10,
    useSection: useIssuesSection,
  },
];
