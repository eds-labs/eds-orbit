"use client";
// The weekly autopilot settings (WP2.3b), moved unchanged from components/management.tsx.
import { useState } from "react";
import { action, post, useMutation, value, libraryAssets } from "@/lib/api";
import { Alert, Button, Loading, Status } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useCollection } from "@/platform/ui/collection";
const weekdays = {
  de: [
    "Sonntag",
    "Montag",
    "Dienstag",
    "Mittwoch",
    "Donnerstag",
    "Freitag",
    "Samstag",
  ],
  en: [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ],
};
export function AutopilotSettings() {
  const { locale, project, isOwner, refresh } = useWorkspace();
  const de = locale === "de";
  const settings = useCollection("autopilot_settings"),
    connectors = useCollection("connectors"),
    facts = useCollection("facts"),
    assets = useCollection("assets");
  const current = settings.data?.items[0]?.data as
    Record<string, unknown> | undefined;
  const connector = connectors.data?.items.find(
    (c) => c.data.provider === "postiz",
  );
  const assigned = new Set(
    Array.isArray(connector?.data.assignedIntegrationIds)
      ? connector.data.assignedIntegrationIds.map(String)
      : [],
  );
  const postingTimes = (connector?.data.postingTimes ?? {}) as Record<
    string,
    string
  >;
  const channels = (
    Array.isArray(connector?.data.channels) ? connector.data.channels : []
  ).filter((ch: Record<string, unknown>) => assigned.has(String(ch.id)));
  const factOptions = (facts.data?.items ?? []).filter(
    (f) =>
      f.data.status === "verified" &&
      f.data.publicUse === true &&
      f.data.valueType !== "url",
  );
  const assetOptions = libraryAssets(assets.data?.items).filter(
    (a) => a.data.usageApproved === true,
  );
  const [form, setForm] = useState<{
    enabled: boolean;
    channels: string[];
    factKeys: string[];
    assetIds: string[];
    planWeekday: number;
    planTime: string;
    startDate?: string;
  } | null>(null);
  const values = form ?? {
    enabled: current?.enabled === true,
    channels: Array.isArray(current?.channels)
      ? (current.channels as string[])
      : channels.map((ch: Record<string, unknown>) => String(ch.id)),
    factKeys: Array.isArray(current?.factKeys)
      ? (current.factKeys as string[])
      : factOptions.map((f) => String(f.data.key)),
    assetIds: Array.isArray(current?.assetIds)
      ? (current.assetIds as string[])
      : assetOptions.slice(0, 1).map((a) => a.id),
    planWeekday:
      typeof current?.planWeekday === "number" ? current.planWeekday : 0,
    planTime:
      typeof current?.planTime === "string" ? current.planTime : "12:00",
    ...(typeof current?.startDate === "string"
      ? { startDate: current.startDate }
      : {}),
  };
  const set = (patch: Partial<typeof values>) =>
    setForm({ ...values, ...patch });
  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((v) => v !== id);
  const mutation = useMutation(() => {
    setForm(null);
    refresh();
  });
  if (settings.loading || connectors.loading || facts.loading)
    return <Loading />;
  return (
    <section className="panel autopilot-settings">
      <div className="panel-head">
        <div>
          <h2>Autopilot</h2>
          <p>
            {de
              ? "Orbit plant jede Woche einen Post pro Kanal und Tag zur festen Uhrzeit. Reine Fakten-Posts gehen nach bestandener Prüfung automatisch raus, Posts mit Werbetext warten auf deine Freigabe unter „Freigaben“."
              : "Orbit plans one post per channel and day at its fixed time every week. Fact-only posts go out after passing review; posts with marketing copy wait for your approval in Approvals."}
          </p>
        </div>
        <Status value={current?.enabled === true ? "enabled" : "disabled"} />
      </div>
      {project.mode !== "autopilot" && (
        <Alert kind="warning">
          {de
            ? "Der Autopilot plant erst, wenn die aktive Richtlinie im Modus „autopilot“ ist."
            : "Autopilot only plans while the active policy is in autopilot mode."}
        </Alert>
      )}
      <label className="review-confirm">
        <input
          type="checkbox"
          checked={values.enabled}
          disabled={!isOwner}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        <span>{de ? "Autopilot aktiv" : "Autopilot enabled"}</span>
      </label>
      <fieldset className="autopilot-group">
        <legend>{de ? "Kanäle" : "Channels"}</legend>
        {channels.map((ch: Record<string, unknown>) => {
          const id = String(ch.id);
          return (
            <label key={id}>
              <input
                type="checkbox"
                checked={values.channels.includes(id)}
                disabled={!isOwner}
                onChange={(e) =>
                  set({
                    channels: toggle(values.channels, id, e.target.checked),
                  })
                }
              />
              <span>
                {String(ch.name)} · {String(ch.identifier)} ·{" "}
                {postingTimes[id]
                  ? `${de ? "täglich" : "daily"} ${postingTimes[id]}`
                  : de
                    ? "keine Uhrzeit (unter Verbindungen festlegen)"
                    : "no time (set it under Connections)"}
              </span>
            </label>
          );
        })}
      </fieldset>
      <fieldset className="autopilot-group">
        <legend>{de ? "Fakten im Wechsel" : "Rotating facts"}</legend>
        {factOptions.map((f) => {
          const key = String(f.data.key);
          return (
            <label key={f.id}>
              <input
                type="checkbox"
                checked={values.factKeys.includes(key)}
                disabled={!isOwner}
                onChange={(e) =>
                  set({
                    factKeys: toggle(values.factKeys, key, e.target.checked),
                  })
                }
              />
              <span>
                <strong>{key}</strong> — {String(f.data.value).slice(0, 120)}
              </span>
            </label>
          );
        })}
      </fieldset>
      <fieldset className="autopilot-group">
        <legend>{de ? "Bild" : "Image"}</legend>
        {assetOptions.map((a) => (
          <label key={a.id}>
            <input
              type="checkbox"
              checked={values.assetIds.includes(a.id)}
              disabled={!isOwner}
              onChange={(e) =>
                set({
                  assetIds: toggle(values.assetIds, a.id, e.target.checked),
                })
              }
            />
            <span>{value(a, "name", value(a, "title", a.id))}</span>
          </label>
        ))}
      </fieldset>
      <div className="autopilot-plan">
        <label>
          <span>{de ? "Wochenplanung am" : "Plan the week on"}</span>
          <select
            value={values.planWeekday}
            disabled={!isOwner}
            onChange={(e) => set({ planWeekday: Number(e.target.value) })}
          >
            {weekdays[de ? "de" : "en"].map((day, i) => (
              <option key={day} value={i}>
                {day}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{de ? "Planen ab" : "Plan from"}</span>
          <input
            type="date"
            value={values.startDate ?? ""}
            disabled={!isOwner}
            onChange={(e) => {
              const { startDate: _drop, ...rest } = values;
              setForm(
                e.target.value ? { ...rest, startDate: e.target.value } : rest,
              );
            }}
          />
        </label>
        <label>
          <span>{de ? "um" : "at"}</span>
          <input
            type="time"
            value={values.planTime}
            disabled={!isOwner}
            onChange={(e) => set({ planTime: e.target.value })}
          />
        </label>
      </div>
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {isOwner && (
        <Button
          disabled={mutation.pending || !form}
          onClick={() =>
            mutation.run(() =>
              action(project.id, "configure-autopilot", values),
            )
          }
        >
          {de ? "Speichern" : "Save"}
        </Button>
      )}
    </section>
  );
}
