"use client";
import { useState } from "react";
import { collectionPath, put, useMutation, useResource } from "@/lib/api";
import { Alert, Badge, Button } from "./ui/primitives";
import { useWorkspace } from "./workspace-context";

// The project's proactive signals (ADR 0023, plan §2.2): which detectors may
// notify members in this project. Owners switch detectors; mappings of
// existing notices follow each member's own per-kind choice. Hidden while
// the feature is off (404).

export type SignalSetting = {
  key: string;
  moduleId: string;
  kind: string;
  title: { en: string; de: string };
  source: "event" | "periodic" | "mapping";
  switchable: boolean;
  on: boolean;
};
export type SignalSettings = { mayEdit: boolean; signals: SignalSetting[] };

/** The PUT body: only the switches that changed. */
export function signalSettingsBody(before: SignalSetting[], after: Record<string, boolean>) {
  return {
    signals: Object.fromEntries(
      before.filter((s) => s.switchable && after[s.key] !== undefined && after[s.key] !== s.on).map((s) => [s.key, after[s.key]!]),
    ),
  };
}

export function SignalSettingsPanel({
  data,
  de,
  pending,
  error,
  onSave,
}: {
  data: SignalSettings;
  de: boolean;
  pending: boolean;
  error: string | null;
  onSave(body: ReturnType<typeof signalSettingsBody>): void;
}) {
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const body = signalSettingsBody(data.signals, draft);
  return (
    <section className="connector signal-settings" aria-labelledby="signal-settings-title">
      <div className="connector-body">
        <h2 id="signal-settings-title">{de ? "Proaktive Hinweise" : "Proactive notices"}</h2>
        <p>
          {de
            ? "Was Orbit in diesem Projekt von selbst meldet, ohne KI. Mitglieder wählen in der Glocke, was sie erhalten."
            : "What Orbit reports in this project on its own, without AI. Members choose in the bell what they receive."}
        </p>
        <div className="member-list">
          {data.signals.map((s) => (
            <div className="member-row" key={s.key}>
              {s.switchable ? (
                <label className="field-check">
                  <input
                    type="checkbox"
                    disabled={!data.mayEdit || pending}
                    checked={draft[s.key] ?? s.on}
                    onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.checked }))}
                  />
                  {s.title[de ? "de" : "en"]}
                </label>
              ) : (
                <span>{s.title[de ? "de" : "en"]}</span>
              )}
              {!s.switchable && (
                <Badge tone="neutral">{de ? "Bestehende Benachrichtigung" : "Existing notification"}</Badge>
              )}
            </div>
          ))}
        </div>
        {error && <Alert kind="error">{error}</Alert>}
        {data.mayEdit && (
          <div className="form-actions">
            <Button disabled={pending || !Object.keys(body.signals).length} onClick={() => onSave(body)}>
              {de ? "Speichern" : "Save"}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

/** Modules → Modules and signals in the project settings: the project's signal switches. */
export function SignalSettingsSection() {
  const { project, locale } = useWorkspace();
  const [revision, setRevision] = useState(0);
  const settings = useResource<SignalSettings>(collectionPath(project.id, `signal-settings?r=${revision}`));
  const save = useMutation(() => setRevision((n) => n + 1));
  if (!settings.data || settings.error?.status === 404) return null;
  return (
    <SignalSettingsPanel
      key={revision}
      data={settings.data}
      de={locale === "de"}
      pending={save.pending}
      error={save.error}
      onSave={(body) => save.run(() => put(collectionPath(project.id, "signal-settings"), body))}
    />
  );
}
