"use client";
import { useContext, useState } from "react";
import { put, remove, useMutation, useResource } from "@/lib/api";
import { ShellContext } from "@/platform/shell/shell-context";
import type { Locale } from "@/lib/i18n";
import {
  aiErrorText,
  aiProviderName,
  aiTasks,
  shownAiTasks,
  levelName,
  presetLevels,
  presetName,
  taskName,
  taskRoutesFrom,
  tiersText,
  type AiDefaults,
  type Presets,
} from "@/lib/ai-presets";
import { Alert, Badge, Button, Loading, Modal } from "@/components/ui/primitives";
import { ResourceError } from "@/platform/ui/collection";
import { DataForm, str, type FormField } from "@/platform/ui/form";

// "Standard-Modelle" (plans/ai-central-management.md, phase B): the
// organization's (owners) or the system's (administrators) provider and
// level, image model and, advanced, one model per task. Projects without
// own settings, and projects that chose the standard, use them.

type DefaultsView = {
  enabled: boolean;
  defaults: AiDefaults | null;
  presets: Presets;
};
type CatalogRow = {
  id: string;
  provider: "openai" | "anthropic";
  purpose: "text" | "image" | "embedding";
  displayName: string;
  active: boolean;
};

const text = {
  en: {
    title: "Standard models",
    intro:
      "One choice for every project: provider and level. Projects without own AI settings use it, and projects can adopt it with one click.",
    none: "Not set: projects use their own settings.",
    off: "Not switched on for this installation yet; saved choices apply once it is.",
    image: "Image model",
    noImage: "No standard image model",
    deviations: "Own models for",
    change: "Change",
    set: "Set standard",
    clear: "Remove",
    provider: "Provider",
    level: "Level",
    advanced: "Choose a model per task (advanced)",
    no: "No",
    yes: "Yes",
    levelTask: "Level",
    save: "Save",
    tiers: "Models per level",
  },
  de: {
    title: "Standard-Modelle",
    intro:
      "Eine Wahl für alle Projekte: Anbieter und Stufe. Projekte ohne eigene KI-Einstellungen nutzen sie, und jedes Projekt kann sie mit einem Klick übernehmen.",
    none: "Nicht festgelegt: Projekte nutzen ihre eigenen Einstellungen.",
    off: "Für diese Installation noch nicht eingeschaltet; die gespeicherte Wahl gilt, sobald es so weit ist.",
    image: "Bildmodell",
    noImage: "Kein Standard-Bildmodell",
    deviations: "Eigene Modelle für",
    change: "Ändern",
    set: "Standard festlegen",
    clear: "Entfernen",
    provider: "Anbieter",
    level: "Stufe",
    advanced: "Modell pro Aufgabe wählen (erweitert)",
    no: "Nein",
    yes: "Ja",
    levelTask: "Stufe",
    save: "Speichern",
    tiers: "Modelle je Stufe",
  },
} as const;

export function AiDefaultsPanel({
  path,
  modelsPath,
  locale,
}: {
  /** "/admin/ai/defaults" or "/organizations/:id/ai/defaults". */
  path: string;
  /** The matching "Modelle & Preise" list. */
  modelsPath: string;
  locale: Locale;
}) {
  const t = text[locale === "de" ? "de" : "en"];
  const view = useResource<DefaultsView>(path);
  const models = useResource<{ models: CatalogRow[] }>(modelsPath);
  const [editing, setEditing] = useState(false);
  const clear = useMutation(view.refresh);
  if (view.loading && !view.data) return <Loading />;
  if (!view.data) return <ResourceError error={view.error} retry={view.refresh} />;
  const current = view.data.defaults;
  const deviations = current
    ? aiTasks.filter((task) => current.taskRoutes[task.id])
    : [];
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{t.title}</h2>
          <p>{t.intro}</p>
        </div>
        <div className="page-actions">
          <Button variant="outline" onClick={() => setEditing(true)}>
            {current ? t.change : t.set}
          </Button>
          {current && (
            <Button
              variant="outline"
              disabled={clear.pending}
              onClick={() => clear.run(() => remove(path))}
            >
              {t.clear}
            </Button>
          )}
        </div>
      </div>
      {!view.data.enabled && <Alert kind="warning">{t.off}</Alert>}
      {clear.error && <Alert kind="error">{aiErrorText(clear.error, locale)}</Alert>}
      {current ? (
        <div className="capability-readiness">
          <div className="data-row">
            <div>
              <strong>{presetName(current, locale)}</strong>
              <p>{tiersText(view.data.presets[current.provider][current.level], locale)}</p>
            </div>
            <Badge tone={view.data.enabled ? "success" : "neutral"}>
              {aiProviderName[current.provider]}
            </Badge>
          </div>
          <div className="data-row">
            <div>
              <strong>{t.image}</strong>
              <p>{current.imageModel ?? t.noImage}</p>
            </div>
          </div>
          {deviations.length > 0 && (
            <div className="data-row">
              <div>
                <strong>{t.deviations}</strong>
                <p>
                  {deviations
                    .map((task) => `${taskName(task, locale)}: ${current.taskRoutes[task.id]!.model}`)
                    .join(" · ")}
                </p>
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="panel-note">{t.none}</p>
      )}
      {editing && (
        <DefaultsForm
          path={path}
          locale={locale}
          view={view.data}
          catalog={models.data?.models ?? []}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            view.refresh();
          }}
        />
      )}
    </section>
  );
}

function DefaultsForm({
  path,
  locale,
  view,
  catalog,
  onClose,
  onSaved,
}: {
  path: string;
  locale: Locale;
  view: DefaultsView;
  catalog: CatalogRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = text[locale === "de" ? "de" : "en"];
  const features = useContext(ShellContext)?.features;
  const mutation = useMutation(onSaved);
  const current = view.defaults;
  const active = catalog.filter((m) => m.active);
  const option = (m: CatalogRow) => ({ value: m.id, label: `${m.displayName} · ${m.id}` });
  const textModels = active.filter((m) => m.purpose === "text").map(option);
  const fields: FormField[] = [
    {
      name: "provider",
      label: t.provider,
      type: "select",
      value: current?.provider ?? "anthropic",
      options: (["anthropic", "openai"] as const).map((p) => ({
        value: p,
        label: aiProviderName[p],
      })),
    },
    {
      name: "level",
      label: t.level,
      type: "select",
      value: current?.level ?? "balanced",
      options: presetLevels.map((level) => ({ value: level, label: levelName(level, locale) })),
      hint: `${t.tiers}: ${presetLevels
        .map(
          (level) =>
            `${levelName(level, locale)}: Claude ${tiersText(view.presets.anthropic[level], locale)}; OpenAI ${tiersText(view.presets.openai[level], locale)}`,
        )
        .join(" — ")}`,
    },
    {
      name: "imageModel",
      label: t.image,
      type: "select",
      value: current?.imageModel ?? "",
      options: [
        { value: "", label: t.noImage },
        ...active.filter((m) => m.purpose === "image").map(option),
      ],
    },
    {
      name: "advanced",
      label: t.advanced,
      type: "select",
      value: Object.keys(current?.taskRoutes ?? {}).length ? "yes" : "no",
      options: [
        { value: "no", label: t.no },
        { value: "yes", label: t.yes },
      ],
    },
    ...shownAiTasks(features).map(
      (task): FormField => ({
        name: `task-${task.id}`,
        label: taskName(task, locale),
        type: "select",
        value: current?.taskRoutes[task.id]?.model ?? "",
        options: [{ value: "", label: t.levelTask }, ...textModels],
        showWhen: { name: "advanced", values: ["yes"] },
      }),
    ),
  ];
  return (
    <Modal title={t.title} onClose={onClose}>
      <DataForm
        fields={fields}
        pending={mutation.pending}
        error={aiErrorText(mutation.error, locale)}
        submitLabel={t.save}
        onCancel={onClose}
        onSubmit={(values) =>
          mutation.run(() => {
            const image = str(values, "imageModel");
            return put(path, {
              provider: str(values, "provider"),
              level: str(values, "level"),
              ...(image ? { imageModel: image } : {}),
              taskRoutes:
                str(values, "advanced") === "yes"
                  ? taskRoutesFrom(values, current?.taskRoutes)
                  : {},
            });
          })
        }
      />
    </Modal>
  );
}
