"use client";
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { action, useMutation } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import {
  aiErrorText,
  aiProviderName,
  aiTasks,
  levelName,
  presetLevels,
  presetName,
  taskName,
  taskRoutesFrom,
  tiersText,
  type AiDefaults,
  type AiProvider,
  type PresetLevel,
  type Presets,
  type TaskRoute,
} from "@/lib/ai-presets";
import { Alert, Badge, Button, Modal } from "./ui/primitives";
import { DataForm, str, type FormField, type FormValues } from "@/platform/ui/form";
import { useWorkspace } from "./workspace-context";

// The project's model choice and first setup (plans/ai-central-management.md,
// phase B): the organization's standard models, an own preset, or the
// project's own tiers and routes ("custom", the settings of before). Shown
// only while the server reports `defaults` (ORBIT_AI_DEFAULTS on).

type Routing =
  | { source: "organization"; overrides: Partial<Record<string, TaskRoute>> }
  | {
      source: "preset";
      provider: AiProvider;
      level: PresetLevel;
      overrides: Partial<Record<string, TaskRoute>>;
    };
export type ModelChoiceView = {
  routing?: Routing | null;
  defaults?: {
    standard: (AiDefaults & { source: "organization" | "system" }) | null;
    presets: Presets;
  } | null;
  catalog?: Array<{
    id: string;
    purpose: "text" | "image" | "embedding";
    displayName: string;
    active: boolean;
  }> | null;
  capabilities?: { text: boolean };
  providers: Record<AiProvider, { keyConfigured: boolean }>;
};

const text = {
  en: {
    title: "Model choice",
    intro:
      "Which models this project's tasks use. The organization's standard keeps every project alike; deviate per task only where needed.",
    organization: "Organization standard",
    system: "Orbit standard",
    preset: "Own level",
    custom: "Own settings",
    customNote: "The project's own tiers and task routes (below) apply.",
    noStandard: "The organization has not set standard models yet.",
    deviations: "Own models for",
    change: "Change",
    source: "Models from",
    provider: "Provider",
    level: "Level",
    advanced: "Choose a model per task (advanced)",
    no: "No",
    yes: "Yes",
    levelTask: "As chosen above",
    save: "Save",
    needsKey: "needs a key",
    setupTitle: "Set up AI",
    setupIntro:
      "Three steps: access, models and budget. Nothing is charged before you allow paid use in the last step.",
    start: "Start setup",
    stepKey: "1 · Access",
    stepModels: "2 · Models",
    stepBudget: "3 · Budget",
    keyReady: "A key is available:",
    keyFrom: "Enter the key of the provider you use. It is stored encrypted.",
    key: "API key",
    next: "Next",
    later: "Later",
    budget: "Budget for paid AI",
    budgets: {
      off: "Off: no paid AI for now",
      test: "Test: USD 1 per day, 10 per month, for 14 days",
      normal: "Normal: USD 5 per day, 50 per month, for one year",
    },
    budgetHint: "You can change limits any time under “AI spending authority”.",
    finish: "Finish",
  },
  de: {
    title: "Modellwahl",
    intro:
      "Welche Modelle die Aufgaben dieses Projekts nutzen. Mit dem Organisationsstandard laufen alle Projekte gleich; weiche nur bei einzelnen Aufgaben ab, wo es nötig ist.",
    organization: "Organisationsstandard",
    system: "Orbit-Standard",
    preset: "Eigene Stufe",
    custom: "Eigene Einstellungen",
    customNote: "Es gelten die eigenen Stufen und Aufgaben-Routen des Projekts (unten).",
    noStandard: "Die Organisation hat noch keine Standard-Modelle festgelegt.",
    deviations: "Eigene Modelle für",
    change: "Ändern",
    source: "Modelle aus",
    provider: "Anbieter",
    level: "Stufe",
    advanced: "Modell pro Aufgabe wählen (erweitert)",
    no: "Nein",
    yes: "Ja",
    levelTask: "Wie oben gewählt",
    save: "Speichern",
    needsKey: "braucht einen Key",
    setupTitle: "KI einrichten",
    setupIntro:
      "Drei Schritte: Zugang, Modelle und Budget. Es entstehen keine Kosten, bevor du im letzten Schritt bezahlte Nutzung erlaubst.",
    start: "Einrichtung starten",
    stepKey: "1 · Zugang",
    stepModels: "2 · Modelle",
    stepBudget: "3 · Budget",
    keyReady: "Ein Key ist vorhanden:",
    keyFrom: "Gib den Key des Anbieters ein, den du nutzt. Er wird verschlüsselt gespeichert.",
    key: "API-Key",
    next: "Weiter",
    later: "Später",
    budget: "Budget für bezahlte KI",
    budgets: {
      off: "Aus: vorerst keine bezahlte KI",
      test: "Test: 1 USD pro Tag, 10 pro Monat, 14 Tage lang",
      normal: "Normal: 5 USD pro Tag, 50 pro Monat, ein Jahr lang",
    },
    budgetHint: "Grenzen änderst du jederzeit unter „KI-Ausgabefreigabe“.",
    finish: "Fertig",
  },
} as const;
type Text = (typeof text)["en" | "de"];

const textOf = (locale: Locale): Text => text[locale === "de" ? "de" : "en"];

/** "Organization standard: Claude · Balanced" and its tiers. */
function describe(view: ModelChoiceView, t: Text, locale: Locale) {
  const routing = view.routing;
  const standard = view.defaults?.standard;
  const presets = view.defaults!.presets;
  if (!routing) return { title: t.custom, detail: t.customNote };
  if (routing.source === "preset")
    return {
      title: `${t.preset}: ${presetName(routing, locale)}`,
      detail: tiersText(presets[routing.provider][routing.level], locale),
    };
  if (!standard) return { title: t.organization, detail: t.noStandard };
  return {
    title: `${standard.source === "system" ? t.system : t.organization}: ${presetName(standard, locale)}`,
    detail: tiersText(presets[standard.provider][standard.level], locale),
  };
}

export function ModelChoicePanel({
  view,
  onChanged,
}: {
  view: ModelChoiceView;
  onChanged: () => void;
}) {
  const { locale } = useWorkspace();
  const t = textOf(locale);
  const [editing, setEditing] = useState(false);
  if (!view.defaults) return null;
  const { title, detail } = describe(view, t, locale);
  const overrides = view.routing?.overrides ?? {};
  const deviations = aiTasks.filter((task) => overrides[task.id]);
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{t.title}</h2>
          <p>{t.intro}</p>
        </div>
        <Button variant="outline" onClick={() => setEditing(true)}>
          {t.change}
        </Button>
      </div>
      <div className="capability-readiness">
        <div className="data-row">
          <div>
            <strong>{title}</strong>
            <p>{detail}</p>
          </div>
          <Badge tone={view.routing ? "success" : "neutral"}>
            {view.routing?.source === "organization"
              ? t.organization
              : view.routing
                ? t.preset
                : t.custom}
          </Badge>
        </div>
        {deviations.length > 0 && (
          <div className="data-row">
            <div>
              <strong>{t.deviations}</strong>
              <p>
                {deviations
                  .map((task) => `${taskName(task, locale)}: ${overrides[task.id]!.model}`)
                  .join(" · ")}
              </p>
            </div>
          </div>
        )}
      </div>
      {editing && (
        <ChoiceForm
          view={view}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}
    </section>
  );
}

/** Source, preset and per-task deviations; "custom" leaves them unused. */
function choiceFields(
  view: ModelChoiceView,
  t: Text,
  locale: Locale,
  options: { custom: boolean; advanced: boolean },
): FormField[] {
  const routing = view.routing;
  const standard = view.defaults?.standard;
  const keyed = (p: AiProvider) =>
    `${aiProviderName[p]}${view.providers[p].keyConfigured ? "" : ` (${t.needsKey})`}`;
  const textModels = (view.catalog ?? [])
    .filter((m) => m.active && m.purpose === "text")
    .map((m) => ({ value: m.id, label: `${m.displayName} · ${m.id}` }));
  const overrides = routing?.overrides ?? {};
  const sources = [
    ...(standard
      ? [
          {
            value: "organization",
            label: `${standard.source === "system" ? t.system : t.organization} (${presetName(standard, locale)})`,
          },
        ]
      : []),
    { value: "preset", label: t.preset },
    ...(options.custom ? [{ value: "custom", label: t.custom }] : []),
  ];
  const preferred: AiProvider = view.providers.anthropic.keyConfigured
    ? "anthropic"
    : "openai";
  return [
    {
      name: "source",
      label: t.source,
      type: "select",
      value: routing?.source ?? (standard ? "organization" : options.custom ? "custom" : "preset"),
      options: sources,
    },
    {
      name: "provider",
      label: t.provider,
      type: "select",
      value: routing?.source === "preset" ? routing.provider : preferred,
      options: (["anthropic", "openai"] as const).map((p) => ({ value: p, label: keyed(p) })),
      showWhen: { name: "source", values: ["preset"] },
    },
    {
      name: "level",
      label: t.level,
      type: "select",
      value: routing?.source === "preset" ? routing.level : "balanced",
      options: presetLevels.map((level) => ({ value: level, label: levelName(level, locale) })),
      showWhen: { name: "source", values: ["preset"] },
    },
    ...(options.advanced
      ? [
          {
            name: "advanced",
            label: t.advanced,
            type: "select" as const,
            value: Object.keys(overrides).length ? "yes" : "no",
            options: [
              { value: "no", label: t.no },
              { value: "yes", label: t.yes },
            ],
          },
          ...aiTasks.map(
            (task): FormField => ({
              name: `task-${task.id}`,
              label: taskName(task, locale),
              type: "select",
              value: overrides[task.id]?.model ?? "",
              options: [{ value: "", label: t.levelTask }, ...textModels],
              showWhen: { name: "advanced", values: ["yes"] },
            }),
          ),
        ]
      : []),
  ];
}

/** The routing section `ai-configure` takes, from the choice form's values. */
function routingFrom(values: FormValues, view: ModelChoiceView) {
  const source = str(values, "source");
  if (source === "custom") return { source };
  const overrides =
    str(values, "advanced") === "yes"
      ? taskRoutesFrom(values, view.routing?.overrides)
      : {};
  return source === "preset"
    ? {
        source,
        provider: str(values, "provider"),
        level: str(values, "level"),
        overrides,
      }
    : { source, overrides };
}

function ChoiceForm({
  view,
  onClose,
  onSaved,
}: {
  view: ModelChoiceView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { project, refresh, locale } = useWorkspace();
  const t = textOf(locale);
  const mutation = useMutation(() => {
    refresh();
    onSaved();
  });
  return (
    <Modal title={t.title} onClose={onClose}>
      <DataForm
        fields={choiceFields(view, t, locale, { custom: true, advanced: true })}
        pending={mutation.pending}
        error={aiErrorText(mutation.error, locale)}
        submitLabel={t.save}
        onCancel={onClose}
        onSubmit={(values) =>
          mutation.run(() =>
            action(project.id, "ai-configure", { routing: routingFrom(values, view) }),
          )
        }
      />
    </Modal>
  );
}

/**
 * The guided first setup, offered while text cannot run: a key (the
 * organization's or an own one), the models (standard or a level), and the
 * spending authority's profile.
 */
export function AiSetupPanel({
  view,
  saveKey,
  onChanged,
}: {
  view: ModelChoiceView;
  /** Saves an own key of the provider through the project's AI settings. */
  saveKey: (provider: AiProvider, key: string) => Promise<unknown>;
  onChanged: () => void;
}) {
  const { locale } = useWorkspace();
  const t = textOf(locale);
  const [open, setOpen] = useState(false);
  // An open wizard stays open when a saved key already makes text ready.
  if (!open && (!view.defaults || !view.capabilities || view.capabilities.text))
    return null;
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{t.setupTitle}</h2>
          <p>{t.setupIntro}</p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Sparkles data-icon="inline-start" />
          {t.start}
        </Button>
      </div>
      {open && (
        <SetupWizard
          view={view}
          saveKey={saveKey}
          onChanged={onChanged}
          onClose={() => {
            setOpen(false);
            onChanged();
          }}
        />
      )}
    </section>
  );
}

function SetupWizard({
  view,
  saveKey,
  onChanged,
  onClose,
}: {
  view: ModelChoiceView;
  saveKey: (provider: AiProvider, key: string) => Promise<unknown>;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { project, refresh, locale } = useWorkspace();
  const t = textOf(locale);
  const keys = (["anthropic", "openai"] as const).filter(
    (p) => view.providers[p].keyConfigured,
  );
  const [step, setStep] = useState<"key" | "models" | "budget">(
    keys.length ? "models" : "key",
  );
  const mutation = useMutation(() => {
    refresh();
    onChanged();
  });
  // Runs a save and moves on only when it succeeded.
  const save = (task: () => Promise<unknown>, then: () => void) =>
    mutation
      .run(async () => {
        await task();
        return true;
      })
      .then((done) => {
        if (done) then();
      });
  const title =
    step === "key" ? t.stepKey : step === "models" ? t.stepModels : t.stepBudget;
  return (
    <Modal title={`${t.setupTitle} · ${title}`} onClose={onClose}>
      {step === "key" && (
        <>
          {keys.length > 0 && (
            <Alert kind="success">
              {t.keyReady} {keys.map((p) => aiProviderName[p]).join(", ")}
            </Alert>
          )}
          <p className="panel-note">{t.keyFrom}</p>
          <DataForm
            fields={[
              {
                name: "provider",
                label: t.provider,
                type: "select",
                value: "anthropic",
                options: (["anthropic", "openai"] as const).map((p) => ({
                  value: p,
                  label: aiProviderName[p],
                })),
              },
              { name: "key", label: t.key, type: "password", required: true },
            ]}
            pending={mutation.pending}
            error={aiErrorText(mutation.error, locale)}
            submitLabel={t.next}
            onCancel={onClose}
            onSubmit={(values) =>
              save(
                () => saveKey(str(values, "provider") as AiProvider, str(values, "key")),
                () => setStep("models"),
              )
            }
          />
        </>
      )}
      {step === "models" && (
        <DataForm
          fields={choiceFields(view, t, locale, { custom: false, advanced: false })}
          pending={mutation.pending}
          error={aiErrorText(mutation.error, locale)}
          submitLabel={t.next}
          onCancel={onClose}
          onSubmit={(values) =>
            save(
              () =>
                action(project.id, "ai-configure", { routing: routingFrom(values, view) }),
              () => setStep("budget"),
            )
          }
        />
      )}
      {step === "budget" && (
        <>
          <p className="panel-note">{t.budgetHint}</p>
          <DataForm
            fields={[
              {
                name: "profile",
                label: t.budget,
                type: "select",
                value: "test",
                options: (["off", "test", "normal"] as const).map((p) => ({
                  value: p,
                  label: t.budgets[p],
                })),
              },
            ]}
            pending={mutation.pending}
            error={aiErrorText(mutation.error, locale)}
            submitLabel={t.finish}
            onCancel={() => setStep("models")}
            onSubmit={(values) =>
              save(
                () =>
                  action(project.id, "ai-spend-policy", { profile: str(values, "profile") }),
                onClose,
              )
            }
          />
        </>
      )}
    </Modal>
  );
}
