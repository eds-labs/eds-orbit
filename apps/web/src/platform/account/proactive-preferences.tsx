"use client";
import { useState } from "react";
import type { Project } from "@/lib/api";
import { collectionPath, post, put, useMutation, useResource } from "@/lib/api";
import { Alert, Button, Loading } from "@/components/ui/primitives";
import { TelegramPanel, type TelegramStatus } from "@/components/telegram-connection";
import { withWorkspace } from "@/platform/assistant/api";

// Notifications, quiet hours, digest, per-user Telegram and the briefing on
// /account/assistant (ADR 0023, plan WP4.1 and WP4.4). The settings live in
// the user's own personal space and only decide when and where a notice
// goes: a kind switched off in a project stays off. Hidden while the
// feature is off (404). Voice settings have their own section.

export type DeliveryMode = "immediate" | "digest" | "off";
type PerSeverity = { info: DeliveryMode; attention: DeliveryMode; urgent: DeliveryMode };
export type Preferences = {
  timeZone: string;
  notifications: { email: PerSeverity; telegram: PerSeverity };
  quietHours: { enabled: boolean; start: string; end: string; urgentBreaks: boolean };
  digest: { time: string };
  briefing: {
    enabled: boolean;
    rhythm: "daily" | "weekdays";
    time: string;
    projectIds: string[] | null;
    sections: { approvals: boolean; agentWork: boolean; urgentTickets: boolean; dueTasks: boolean; budget: boolean };
    skipEmpty: boolean;
    email: boolean;
    aiSummary: boolean;
  };
};
export type PreferencesView = {
  personalSpaceId: string;
  version: number;
  preferences: Preferences;
  channels: {
    systemMail: boolean;
    telegram: { available: boolean } & TelegramStatus;
  };
};

export const preferencesPath = (workspaceId?: string) => withWorkspace("/assistant/preferences", workspaceId);

/** The PUT body: every section, bound to the version read. */
export function preferencesPutBody(version: number, p: Preferences) {
  return {
    version,
    timeZone: p.timeZone,
    notifications: p.notifications,
    quietHours: p.quietHours,
    digest: p.digest,
    briefing: p.briefing,
  };
}

/** The browser's time zone, the default before a first save. */
export function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function timeZones(current: string) {
  try {
    const all = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    return all.includes(current) ? all : [current, ...all];
  } catch {
    return [current];
  }
}

export const preferencesText = (de: boolean) => ({
  title: de ? "Benachrichtigungen und Briefing" : "Notifications and briefing",
  intro: de
    ? "Wann und wo dich Orbit über alle deine Projekte informiert. Eine Art, die du in einem Projekt ausgeschaltet hast, bleibt aus."
    : "When and where Orbit tells you about all your projects. A kind you switched off in a project stays off.",
  delivery: de ? "Zustellung nach Dringlichkeit" : "Delivery by urgency",
  severity: { info: de ? "Info" : "Info", attention: de ? "Wichtig" : "Attention", urgent: de ? "Dringend" : "Urgent" },
  email: de ? "E-Mail" : "E-mail",
  telegram: "Telegram",
  modes: {
    immediate: de ? "Sofort" : "Immediately",
    digest: de ? "In der Zusammenfassung" : "In the digest",
    off: de ? "Aus" : "Off",
  },
  timeZone: de ? "Zeitzone" : "Time zone",
  quiet: de ? "Ruhezeiten" : "Quiet hours",
  quietOn: de ? "Ruhezeiten einschalten" : "Use quiet hours",
  quietHint: de
    ? "In dieser Zeit gehen E-Mail und Telegram in die nächste Zusammenfassung. In Orbit siehst du alles sofort."
    : "During this time, e-mail and Telegram wait for the next digest. In Orbit you see everything at once.",
  from: de ? "Von" : "From",
  to: de ? "Bis" : "To",
  urgentBreaks: de ? "Dringendes trotzdem sofort senden" : "Send urgent notices anyway",
  digest: de ? "Zusammenfassung" : "Digest",
  digestTime: de ? "Uhrzeit der täglichen Zusammenfassung" : "Time of the daily digest",
  noSystemMail: de
    ? "Für E-Mail-Zusammenfassungen ist kein System-Absender eingerichtet; sie bleiben in Orbit."
    : "No system sender is set up for e-mail digests; they stay in Orbit.",
  telegramIntro: de
    ? "Dein eigener Bot für kurze Hinweise aus allen Projekten: Titel und Link, nie Inhalte. /stop beendet die Zustellung."
    : "Your own bot for short notices from all your projects: title and link, never content. /stop ends delivery.",
  briefing: "Briefing",
  briefingOn: de ? "Briefing einschalten" : "Send me a briefing",
  rhythm: de ? "Rhythmus" : "Rhythm",
  daily: de ? "Täglich" : "Daily",
  weekdays: de ? "Werktags" : "Weekdays",
  time: de ? "Uhrzeit" : "Time",
  projects: de ? "Projekte" : "Projects",
  allProjects: de ? "Alle Projekte" : "All projects",
  sections: {
    approvals: de ? "Offene Freigaben" : "Pending approvals",
    agentWork: de ? "Agenten-Ergebnisse" : "Agent results",
    urgentTickets: de ? "Dringende Tickets" : "Urgent tickets",
    dueTasks: de ? "Fällige Aufgaben" : "Due tasks",
    budget: de ? "Budgetstand" : "Budget status",
  },
  skipEmpty: de ? "Kein Briefing, wenn es nichts Neues gibt" : "No briefing when there is nothing new",
  briefingEmail: de ? "Auch per E-Mail" : "Also by e-mail",
  aiSummary: de ? "KI-Zusammenfassung (aus deinem Assistenten-Budget, höchstens 0,05 USD)" : "AI summary (from your assistant budget, at most USD 0.05)",
  save: de ? "Speichern" : "Save",
  saved: de ? "Gespeichert." : "Saved.",
});

type Text = ReturnType<typeof preferencesText>;
const SEVERITIES = ["info", "attention", "urgent"] as const;

/** The form for loaded preferences; `onSave` is injectable for tests. */
export function PreferencesForm({
  view,
  de,
  projects,
  pending,
  error,
  success,
  onSave,
}: {
  view: PreferencesView;
  de: boolean;
  projects: Pick<Project, "id" | "name">[];
  pending: boolean;
  error: string | null;
  success: boolean;
  onSave(body: ReturnType<typeof preferencesPutBody>): void;
}) {
  const t = preferencesText(de);
  const [draft, setDraft] = useState<Preferences>(() =>
    view.version === 0 && view.preferences.timeZone === "UTC"
      ? { ...view.preferences, timeZone: browserTimeZone() }
      : view.preferences,
  );
  const set = <K extends keyof Preferences>(key: K, value: Preferences[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const telegramLinked = view.channels.telegram.status === "linked";
  const channels: Array<"email" | "telegram"> = telegramLinked ? ["email", "telegram"] : ["email"];
  const b = draft.briefing;
  const setBriefing = (patch: Partial<Preferences["briefing"]>) => set("briefing", { ...b, ...patch });
  return (
    <form
      className="proactive-preferences"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(preferencesPutBody(view.version, draft));
      }}
    >
      <fieldset className="form-section">
        <legend>{t.delivery}</legend>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{de ? "Dringlichkeit" : "Urgency"}</th>
              {channels.map((c) => (
                <th scope="col" key={c}>
                  {t[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SEVERITIES.map((severity) => (
              <tr key={severity}>
                <th scope="row">{t.severity[severity]}</th>
                {channels.map((channel) => (
                  <td key={channel}>
                    <select
                      className="input"
                      aria-label={`${t[channel]}: ${t.severity[severity]}`}
                      value={draft.notifications[channel][severity]}
                      onChange={(e) =>
                        set("notifications", {
                          ...draft.notifications,
                          [channel]: { ...draft.notifications[channel], [severity]: e.target.value as DeliveryMode },
                        })
                      }
                    >
                      {(["immediate", "digest", "off"] as const).map((mode) => (
                        <option key={mode} value={mode}>
                          {t.modes[mode]}
                        </option>
                      ))}
                    </select>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <label className="field">
          <span>{t.timeZone}</span>
          <select className="input" value={draft.timeZone} onChange={(e) => set("timeZone", e.target.value)}>
            {timeZones(draft.timeZone).map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset className="form-section">
        <legend>{t.quiet}</legend>
        <label className="field-check">
          <input
            type="checkbox"
            checked={draft.quietHours.enabled}
            onChange={(e) => set("quietHours", { ...draft.quietHours, enabled: e.target.checked })}
          />
          {t.quietOn}
        </label>
        <p className="panel-note">{t.quietHint}</p>
        <div className="form-row">
          <label className="field">
            <span>{t.from}</span>
            <input
              className="input"
              type="time"
              required
              disabled={!draft.quietHours.enabled}
              value={draft.quietHours.start}
              onChange={(e) => set("quietHours", { ...draft.quietHours, start: e.target.value })}
            />
          </label>
          <label className="field">
            <span>{t.to}</span>
            <input
              className="input"
              type="time"
              required
              disabled={!draft.quietHours.enabled}
              value={draft.quietHours.end}
              onChange={(e) => set("quietHours", { ...draft.quietHours, end: e.target.value })}
            />
          </label>
        </div>
        <label className="field-check">
          <input
            type="checkbox"
            disabled={!draft.quietHours.enabled}
            checked={draft.quietHours.urgentBreaks}
            onChange={(e) => set("quietHours", { ...draft.quietHours, urgentBreaks: e.target.checked })}
          />
          {t.urgentBreaks}
        </label>
      </fieldset>

      <fieldset className="form-section">
        <legend>{t.digest}</legend>
        <label className="field">
          <span>{t.digestTime}</span>
          <input
            className="input"
            type="time"
            required
            value={draft.digest.time}
            onChange={(e) => set("digest", { time: e.target.value })}
          />
        </label>
        {!view.channels.systemMail && <p className="panel-note">{t.noSystemMail}</p>}
      </fieldset>

      <fieldset className="form-section">
        <legend>{t.briefing}</legend>
        <label className="field-check">
          <input type="checkbox" checked={b.enabled} onChange={(e) => setBriefing({ enabled: e.target.checked })} />
          {t.briefingOn}
        </label>
        <div className="form-row">
          <label className="field">
            <span>{t.rhythm}</span>
            <select
              className="input"
              disabled={!b.enabled}
              value={b.rhythm}
              onChange={(e) => setBriefing({ rhythm: e.target.value as "daily" | "weekdays" })}
            >
              <option value="daily">{t.daily}</option>
              <option value="weekdays">{t.weekdays}</option>
            </select>
          </label>
          <label className="field">
            <span>{t.time}</span>
            <input
              className="input"
              type="time"
              required
              disabled={!b.enabled}
              value={b.time}
              onChange={(e) => setBriefing({ time: e.target.value })}
            />
          </label>
        </div>
        <SectionChecks t={t} briefing={b} disabled={!b.enabled} onChange={(sections) => setBriefing({ sections })} />
        <ProjectChecks t={t} projects={projects} briefing={b} disabled={!b.enabled} onChange={(projectIds) => setBriefing({ projectIds })} />
        {(
          [
            ["skipEmpty", t.skipEmpty],
            ["email", t.briefingEmail],
            ["aiSummary", t.aiSummary],
          ] as const
        ).map(([key, label]) => (
          <label className="field-check" key={key}>
            <input
              type="checkbox"
              disabled={!b.enabled || (key === "email" && !view.channels.systemMail)}
              checked={b[key]}
              onChange={(e) => setBriefing({ [key]: e.target.checked })}
            />
            {label}
          </label>
        ))}
      </fieldset>

      {error && <Alert kind="error">{error}</Alert>}
      <div className="form-actions" aria-live="polite">
        <Button type="submit" disabled={pending}>
          {t.save}
        </Button>
        {success && !pending && <span className="panel-note">{t.saved}</span>}
      </div>
    </form>
  );
}

function SectionChecks({
  t,
  briefing,
  disabled,
  onChange,
}: {
  t: Text;
  briefing: Preferences["briefing"];
  disabled: boolean;
  onChange(sections: Preferences["briefing"]["sections"]): void;
}) {
  return (
    <fieldset className="check-group">
      <legend>{t.briefing}</legend>
      {(Object.keys(t.sections) as Array<keyof Preferences["briefing"]["sections"]>).map((key) => (
        <label className="field-check" key={key}>
          <input
            type="checkbox"
            disabled={disabled}
            checked={briefing.sections[key]}
            onChange={(e) => onChange({ ...briefing.sections, [key]: e.target.checked })}
          />
          {t.sections[key]}
        </label>
      ))}
    </fieldset>
  );
}

function ProjectChecks({
  t,
  projects,
  briefing,
  disabled,
  onChange,
}: {
  t: Text;
  projects: Pick<Project, "id" | "name">[];
  briefing: Preferences["briefing"];
  disabled: boolean;
  onChange(projectIds: string[] | null): void;
}) {
  if (!projects.length) return null;
  const all = briefing.projectIds === null;
  return (
    <fieldset className="check-group">
      <legend>{t.projects}</legend>
      <label className="field-check">
        <input type="checkbox" disabled={disabled} checked={all} onChange={(e) => onChange(e.target.checked ? null : [])} />
        {t.allProjects}
      </label>
      {!all &&
        projects.map((project) => (
          <label className="field-check" key={project.id}>
            <input
              type="checkbox"
              disabled={disabled}
              checked={briefing.projectIds!.includes(project.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...briefing.projectIds!, project.id]
                    : briefing.projectIds!.filter((id) => id !== project.id),
                )
              }
            />
            {project.name}
          </label>
        ))}
    </fieldset>
  );
}

/** The section on /account/assistant; nothing while the feature is off. */
export function ProactivePreferences({
  de,
  workspaceId,
  projects,
}: {
  de: boolean;
  workspaceId?: string;
  projects: Pick<Project, "id" | "name">[];
}) {
  const t = preferencesText(de);
  const [revision, setRevision] = useState(0);
  const resource = useResource<PreferencesView>(`${preferencesPath(workspaceId)}${workspaceId ? "&" : "?"}r=${revision}`);
  const save = useMutation(() => setRevision((n) => n + 1));
  const telegram = useMutation(() => setRevision((n) => n + 1));
  const [link, setLink] = useState<{ linkCode: string; expiresAt: string } | null>(null);
  if (resource.error?.status === 404) return null;
  const view = resource.data;
  return (
    <section className="account-section" aria-labelledby="proactive-preferences-title">
      <h2 id="proactive-preferences-title">{t.title}</h2>
      <p className="panel-note">{t.intro}</p>
      {!view ? (
        resource.error ? (
          <Alert kind="error">{resource.error.message}</Alert>
        ) : (
          <Loading label={de ? "Wird geladen…" : "Loading…"} />
        )
      ) : (
        <>
          <PreferencesForm
            key={view.version}
            view={view}
            de={de}
            projects={projects}
            pending={save.pending}
            error={save.error}
            success={save.success}
            onSave={(body) => save.run(() => put(preferencesPath(workspaceId), body))}
          />
          {view.channels.telegram.available && (
            <TelegramPanel
              description={t.telegramIntro}
              status={view.channels.telegram}
              link={link}
              de={de}
              timezone={view.preferences.timeZone}
              pending={telegram.pending}
              error={telegram.error ?? ""}
              onConnect={(token) =>
                telegram.run(async () =>
                  setLink(
                    await post<{ linkCode: string; expiresAt: string }>(
                      collectionPath(view.personalSpaceId, "telegram/connect"),
                      { token },
                    ),
                  ),
                )
              }
              onDisconnect={() =>
                telegram.run(async () => {
                  await post(collectionPath(view.personalSpaceId, "telegram/disconnect"), {});
                  setLink(null);
                })
              }
            />
          )}
        </>
      )}
    </section>
  );
}
