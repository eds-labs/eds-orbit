"use client";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useMutation } from "@/lib/api";
import { Alert, Button, Input, Loading } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import type { SettingsSection } from "@/platform/shell/types";
import { ResourceError } from "@/platform/ui/collection";
import { STATUS_CATEGORIES, send, workPath, type StatusCategory, type WorkSettings } from "./api";
import { workText, type WorkText } from "./labels";
import { useWorkAccess, useWorkLists } from "./shared";

// The module's settings section (plan §5.4): workflow statuses, task
// categories, teams and the due-date notice. Owners edit; others read.

const KEY = /^[a-z][a-z0-9_]{1,40}$/;
const COLORS = ["gray", "blue", "green", "yellow", "orange", "red", "purple", "pink"];

function WorkSettingsForm() {
  const { project, locale } = useWorkspace();
  const t = workText(locale);
  const access = useWorkAccess();
  const lists = useWorkLists();
  const [draft, setDraft] = useState<WorkSettings | null>(null);
  useEffect(() => {
    if (lists.settings) setDraft(structuredClone(lists.settings));
  }, [lists.settings]);
  const mutation = useMutation(lists.refresh);
  if (lists.loading && !draft) return <Loading />;
  if (lists.error) return <ResourceError error={lists.error} retry={lists.refresh} />;
  if (!draft) return null;
  const readOnly = !access.owner;
  const statuses = [...draft.workflow.statuses].sort((a, b) => a.order - b.order);
  const update = (next: Partial<WorkSettings>) => setDraft({ ...draft, ...next });
  const setStatus = (index: number, patch: Partial<(typeof statuses)[number]>) =>
    update({ workflow: { ...draft.workflow, statuses: statuses.map((s, i) => (i === index ? { ...s, ...patch } : s)) } });
  const valid =
    statuses.every((s) => KEY.test(s.key) && s.label.en.trim() && s.label.de.trim()) &&
    new Set(statuses.map((s) => s.key)).size === statuses.length &&
    statuses.some((s) => s.category === "done") &&
    statuses.some((s) => s.category === "canceled") &&
    draft.categories.every((c) => KEY.test(c.key) && c.label.trim()) &&
    draft.teams.every((team) => KEY.test(team.key) && team.name.trim());
  return (
    <form
      className="settings-form work-stack"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.run(() => send(workPath(project.id, "/settings"), "PUT", { settings: draft, version: lists.version }));
      }}
    >
      <fieldset disabled={readOnly || mutation.pending} className="work-stack">
        <legend>{t.settings.workflow}</legend>
        <p className="support-muted">{t.settings.workflowIntro}</p>
        <ul className="settings-rows">
          {statuses.map((s, i) => (
            <li key={i} className="work-settings-row">
              <Input aria-label={t.settings.key} value={s.key} onChange={(e) => setStatus(i, { key: e.target.value })} />
              <Input aria-label={t.settings.labelEn} value={s.label.en} onChange={(e) => setStatus(i, { label: { ...s.label, en: e.target.value } })} />
              <Input aria-label={t.settings.labelDe} value={s.label.de} onChange={(e) => setStatus(i, { label: { ...s.label, de: e.target.value } })} />
              <select aria-label={t.fields.category} value={s.category} onChange={(e) => setStatus(i, { category: e.target.value as StatusCategory })}>
                {STATUS_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {t.category[c]}
                  </option>
                ))}
              </select>
              <Input
                aria-label={`WIP ${s.key}`}
                type="number"
                min={1}
                placeholder="WIP"
                value={draft.wipLimits[s.key] ?? ""}
                onChange={(e) => {
                  const wipLimits = { ...draft.wipLimits };
                  if (e.target.value) wipLimits[s.key] = Number(e.target.value);
                  else delete wipLimits[s.key];
                  update({ wipLimits });
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`${t.delete}: ${s.key}`}
                onClick={() => update({ workflow: { ...draft.workflow, statuses: statuses.filter((_, j) => j !== i) } })}
              >
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
              workflow: {
                ...draft.workflow,
                statuses: [...statuses, { key: `status_${statuses.length + 1}`, label: { en: "New", de: "Neu" }, category: "todo", order: (statuses.at(-1)?.order ?? 0) + 10 }],
              },
            })
          }
        >
          {t.settings.addStatus}
        </Button>
      </fieldset>
      <ListEditor
        t={t}
        legend={t.settings.categories}
        add={t.settings.addCategory}
        items={draft.categories}
        onChange={(categories) => update({ categories })}
        make={(n) => ({ key: `category_${n}`, label: "", color: "gray" })}
        render={(c, set) => (
          <>
            <Input aria-label={t.settings.key} value={c.key} onChange={(e) => set({ ...c, key: e.target.value })} />
            <Input aria-label={t.fields.category} value={c.label} onChange={(e) => set({ ...c, label: e.target.value })} />
            <select aria-label="Color" value={c.color} onChange={(e) => set({ ...c, color: e.target.value })}>
              {COLORS.map((color) => (
                <option key={color} value={color}>
                  {color}
                </option>
              ))}
            </select>
          </>
        )}
        disabled={readOnly || mutation.pending}
      />
      <ListEditor
        t={t}
        legend={t.settings.teams}
        add={t.settings.addTeam}
        items={draft.teams}
        onChange={(teams) => update({ teams })}
        make={(n) => ({ key: `team_${n}`, name: "", memberUserIds: [] })}
        render={(team, set) => (
          <>
            <Input aria-label={t.settings.key} value={team.key} onChange={(e) => set({ ...team, key: e.target.value })} />
            <Input aria-label={t.settings.teams} value={team.name} onChange={(e) => set({ ...team, name: e.target.value })} />
            <select
              multiple
              aria-label={t.settings.members}
              value={team.memberUserIds}
              onChange={(e) => set({ ...team, memberUserIds: [...e.target.selectedOptions].map((o) => o.value) })}
            >
              {lists.members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </select>
          </>
        )}
        disabled={readOnly || mutation.pending}
      />
      <label>
        {t.settings.dueSoonDays}
        <Input
          type="number"
          min={0}
          max={14}
          disabled={readOnly || mutation.pending}
          value={draft.notifications.dueSoonDays}
          onChange={(e) => update({ notifications: { dueSoonDays: Number(e.target.value) } })}
        />
      </label>
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {mutation.success && <Alert kind="success">{t.settings.saved}</Alert>}
      {!readOnly && (
        <Button type="submit" disabled={!valid || mutation.pending}>
          {t.save}
        </Button>
      )}
    </form>
  );
}

function ListEditor<T>({
  t,
  legend,
  add,
  items,
  onChange,
  make,
  render,
  disabled,
}: {
  t: WorkText;
  legend: string;
  add: string;
  items: T[];
  onChange: (items: T[]) => void;
  make: (n: number) => T;
  render: (item: T, set: (next: T) => void) => React.ReactNode;
  disabled: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="work-stack">
      <legend>{legend}</legend>
      <ul className="settings-rows">
        {items.map((item, i) => (
          <li key={i} className="work-settings-row">
            {render(item, (next) => onChange(items.map((x, j) => (j === i ? next : x))))}
            <Button type="button" variant="ghost" size="icon" aria-label={t.delete} onClick={() => onChange(items.filter((_, j) => j !== i))}>
              <X aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...items, make(items.length + 1)])}>
        {add}
      </Button>
    </fieldset>
  );
}

function useWorkSection() {
  return { content: <WorkSettingsForm /> };
}

/** The module's section of the project settings. */
export const workSettings: readonly SettingsSection[] = [
  {
    tab: { key: "work", label: { en: "Project management", de: "Projektmanagement" }, order: 30 },
    order: 10,
    useSection: useWorkSection,
  },
];
