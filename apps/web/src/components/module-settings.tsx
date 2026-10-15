"use client";
import { useState } from "react";
import { Boxes } from "lucide-react";
import { api, useMutation, useResource } from "@/lib/api";
import { Alert, Badge, Button, Loading, Modal } from "./ui/primitives";
import { useWorkspace } from "./workspace-context";
import { ResourceError } from "@/platform/ui/collection";

// Settings → Modules (WP2.4, docs/MODULE_ACTIVATION.md): owners turn a module
// on or off for the project. Turning one off hides and blocks it; nothing is
// deleted, and turning it on again restores it.

export type ModuleRow = {
  id: string;
  displayName: { en: string; de: string };
  version: string;
  dependsOn: string[];
  enabled: boolean;
  explicit: boolean;
  changedBy: string | null;
  changedAt: string | null;
};

const errors: Record<string, [string, string]> = {
  MODULE_REQUIRED: [
    "Another module that is on needs this one. Turn that module off first.",
    "Ein eingeschaltetes Modul braucht dieses. Schalte jenes zuerst aus.",
  ],
  MODULE_DEPENDENCY_DISABLED: [
    "This module needs a module that is off. Turn that one on first.",
    "Dieses Modul braucht ein ausgeschaltetes Modul. Schalte jenes zuerst ein.",
  ],
};

export function ModuleSettings() {
  const { project, locale, isOwner, refresh, revision } = useWorkspace();
  const resource = useResource<{ switchable: boolean; modules: ModuleRow[] }>(
    `/projects/${encodeURIComponent(project.id)}/modules?revision=${revision}`,
  );
  const mutation = useMutation(refresh);
  const [confirm, setConfirm] = useState<ModuleRow | null>(null);
  const change = (m: ModuleRow, enabled: boolean) =>
    mutation
      .run(() =>
        api(
          `/projects/${encodeURIComponent(project.id)}/modules/${encodeURIComponent(m.id)}`,
          { method: "PUT", body: JSON.stringify({ enabled }) },
        ),
      )
      .then(() => setConfirm(null));
  return (
    <section className="panel">
      <ResourceError error={resource.error} retry={resource.refresh} />
      {resource.loading ? (
        <Loading />
      ) : (
        resource.data && (
          <ModulePanel
            de={locale === "de"}
            switchable={resource.data.switchable}
            isOwner={isOwner}
            modules={resource.data.modules}
            pending={mutation.pending}
            error={mutation.error}
            confirm={confirm}
            onConfirm={setConfirm}
            onChange={(m, enabled) => void change(m, enabled)}
          />
        )
      )}
    </section>
  );
}

/** The module list without data access, so it can be rendered in tests. */
export function ModulePanel({
  de,
  switchable: allowed,
  isOwner,
  modules,
  pending,
  error,
  confirm,
  onConfirm,
  onChange,
}: {
  de: boolean;
  switchable: boolean;
  isOwner: boolean;
  modules: readonly ModuleRow[];
  pending: boolean;
  error: string | null | undefined;
  confirm: ModuleRow | null;
  onConfirm: (m: ModuleRow | null) => void;
  onChange: (m: ModuleRow, enabled: boolean) => void;
}) {
  const name = (m: ModuleRow) => m.displayName[de ? "de" : "en"];
  const nameOf = (id: string) => {
    const m = modules.find((row) => row.id === id);
    return m ? name(m) : id;
  };
  const switchable = allowed && isOwner;
  const failure = error
    ? (errors[error.replaceAll(" ", "_")]?.[de ? 1 : 0] ?? error)
    : null;
  return (
    <>
      <div className="panel-head">
        <div>
          <h2>{de ? "Module" : "Modules"}</h2>
          <p>
            {de
              ? "Ausgeschaltete Module sind verborgen und gesperrt. Nichts wird gelöscht; einschalten stellt alles wieder her."
              : "A module that is off is hidden and blocked. Nothing is deleted; turning it on restores everything."}
          </p>
        </div>
      </div>
      {!allowed && (
        <Alert>
          {de
            ? "Das Umschalten von Modulen ist in dieser Installation nicht freigeschaltet."
            : "Switching modules is not enabled on this installation."}
        </Alert>
      )}
      {failure && <Alert kind="error">{failure}</Alert>}
      <div className="data-list">
        {modules.map((m) => (
          <div className="data-row" key={m.id}>
            <Boxes aria-hidden="true" />
            <div>
              <strong>{name(m)}</strong>
              <p>
                Version {m.version}
                {m.dependsOn.length > 0 &&
                  ` · ${de ? "braucht" : "needs"} ${m.dependsOn.map(nameOf).join(", ")}`}
              </p>
            </div>
            <Badge tone={m.enabled ? "success" : "neutral"}>
              {m.enabled ? (de ? "an" : "on") : de ? "aus" : "off"}
            </Badge>
            {switchable && (
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                aria-label={`${m.enabled ? (de ? "Ausschalten" : "Turn off") : de ? "Einschalten" : "Turn on"}: ${name(m)}`}
                onClick={() => (m.enabled ? onConfirm(m) : onChange(m, true))}
              >
                {m.enabled
                  ? de
                    ? "Ausschalten"
                    : "Turn off"
                  : de
                    ? "Einschalten"
                    : "Turn on"}
              </Button>
            )}
          </div>
        ))}
      </div>
      {confirm && (
        <Modal
          title={
            de ? `${name(confirm)} ausschalten?` : `Turn off ${name(confirm)}?`
          }
          description={
            de
              ? "Seiten, Assistent-Werkzeuge und Aufgaben dieses Moduls werden verborgen und angehalten. Nichts wird gelöscht; du kannst es jederzeit wieder einschalten."
              : "Its pages, assistant tools and jobs are hidden and stopped. Nothing is deleted; you can turn it on again at any time."
          }
          onClose={() => onConfirm(null)}
        >
          <div className="form-actions">
            <Button variant="outline" onClick={() => onConfirm(null)}>
              {de ? "Abbrechen" : "Cancel"}
            </Button>
            <Button disabled={pending} onClick={() => onChange(confirm, false)}>
              {de ? "Ausschalten" : "Turn off"}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
