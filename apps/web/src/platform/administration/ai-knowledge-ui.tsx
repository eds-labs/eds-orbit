"use client";
import { useState } from "react";
import { BookOpen } from "lucide-react";
import { post, put, remove, useMutation, useResource } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Alert, Badge, Button, Empty, Loading, Modal } from "@/components/ui/primitives";
import { ResourceError } from "@/platform/ui/collection";
import { DataForm, str, type FormField, type FormValues } from "@/platform/ui/form";
import { errorText } from "./texts";

// AI profiles and organization knowledge libraries (ADR 0014). A profile
// holds models, routes, rate cards and defaults, never keys; a project's
// own AI settings still override it. Libraries are ordinary projects whose
// knowledge is managed in the project's knowledge pages; shares decide
// which projects and modules may search them.

type Profile = {
  version: number;
  data: {
    defaultProvider?: "openai" | "anthropic";
    verifiedModels?: string[];
    modelRoutes?: Record<"fast" | "standard" | "quality" | "escalation", string>;
    rateCard?: Record<string, unknown>;
    taskRoutes?: Record<string, unknown>;
    anthropicTierRoutes?: Record<"fast" | "standard" | "quality", string>;
    providerBudgets?: Record<string, unknown>;
  } & Record<string, unknown>;
};

// The editor's own refusals, before anything is sent.
type ProfileFormError =
  | "PROFILE_JSON_INVALID"
  | "PROFILE_ROUTES_INCOMPLETE"
  | "PROFILE_TIERS_INCOMPLETE";
const profileErrors: Record<ProfileFormError, { en: string; de: string }> = {
  PROFILE_ROUTES_INCOMPLETE: {
    en: "Fill in all four routes or leave all four empty.",
    de: "Fülle alle vier Routen aus oder lass alle vier leer.",
  },
  PROFILE_TIERS_INCOMPLETE: {
    en: "Fill in all three Claude tiers or leave all three empty.",
    de: "Fülle alle drei Claude-Stufen aus oder lass alle drei leer.",
  },
  PROFILE_JSON_INVALID: {
    en: "The rate card or the budgets are not valid JSON.",
    de: "Preise oder Budgets sind kein gültiges JSON.",
  },
};

/** The profile form's fields, prefilled from the stored profile. */
export function profileFields(d: Profile["data"], locale: Locale): FormField[] {
  const de = locale === "de";
  const routes = d.modelRoutes;
  return [
    {
      name: "defaultProvider",
      label: de ? "Standardanbieter" : "Default provider",
      type: "select",
      value: d.defaultProvider ?? "",
      options: [
        { value: "", label: de ? "nicht festgelegt" : "not set" },
        { value: "openai", label: "OpenAI" },
        { value: "anthropic", label: "Anthropic Claude" },
      ],
    },
    {
      name: "verifiedModels",
      label: de ? "Geprüfte Modelle (kommagetrennt)" : "Verified models (comma-separated)",
      value: (d.verifiedModels ?? []).join(", "),
    },
    { name: "fast", label: "Route fast", value: routes?.fast ?? "" },
    { name: "standard", label: "Route standard", value: routes?.standard ?? "" },
    { name: "quality", label: "Route quality", value: routes?.quality ?? "" },
    { name: "escalation", label: "Route escalation", value: routes?.escalation ?? "" },
    // Claude's tiers, used while Claude is the default provider (phase 3.3).
    {
      name: "claudeFast",
      heading: "Claude",
      label: de ? "Claude-Stufe fast" : "Claude tier fast",
      value: d.anthropicTierRoutes?.fast ?? "",
    },
    {
      name: "claudeStandard",
      label: de ? "Claude-Stufe standard" : "Claude tier standard",
      value: d.anthropicTierRoutes?.standard ?? "",
    },
    {
      name: "claudeQuality",
      label: de ? "Claude-Stufe quality" : "Claude tier quality",
      value: d.anthropicTierRoutes?.quality ?? "",
    },
    {
      name: "rateCard",
      label: de ? "Preise (JSON: Modell → USD-Micros je Mio. Tokens)" : "Rate card (JSON: model → USD micros per million tokens)",
      type: "textarea",
      value: d.rateCard ? JSON.stringify(d.rateCard, null, 2) : "",
    },
    {
      name: "providerBudgets",
      label: de
        ? "Anbieter-Budgets (JSON: anthropic/openai → monthlyMicros, warnMicros, warn2Micros, stopMicros, anchorDay)"
        : "Provider budgets (JSON: anthropic/openai → monthlyMicros, warnMicros, warn2Micros, stopMicros, anchorDay)",
      type: "textarea",
      value: d.providerBudgets ? JSON.stringify(d.providerBudgets, null, 2) : "",
      hint: de
        ? "Projekte ohne eigenes Budget übernehmen es."
        : "Projects without their own budget inherit it.",
    },
  ];
}

/**
 * The whole profile to send: the shown fields from the form, every other
 * field (the standard models included) from the stored copy. A route or
 * tier set is sent whole or left out when all of it was cleared; a partly
 * filled set is refused instead of silently removing it (risk 7).
 */
export function profilePayload(
  stored: Profile["data"],
  values: FormValues,
):
  | { payload: Record<string, unknown> }
  | { error: ProfileFormError } {
  let rateCard: unknown;
  let providerBudgets: unknown;
  try {
    rateCard = str(values, "rateCard") ? JSON.parse(str(values, "rateCard")) : undefined;
    providerBudgets = str(values, "providerBudgets")
      ? JSON.parse(str(values, "providerBudgets"))
      : undefined;
  } catch {
    return { error: "PROFILE_JSON_INVALID" };
  }
  const route = ["fast", "standard", "quality", "escalation"].map((k) => str(values, k));
  if (route.some(Boolean) && !route.every(Boolean))
    return { error: "PROFILE_ROUTES_INCOMPLETE" };
  const tiers = ["claudeFast", "claudeStandard", "claudeQuality"].map((k) =>
    str(values, k),
  );
  if (tiers.some(Boolean) && !tiers.every(Boolean))
    return { error: "PROFILE_TIERS_INCOMPLETE" };
  // Fields this form does not show are kept as they are.
  const {
    defaultProvider: _p,
    verifiedModels: _v,
    modelRoutes: _m,
    rateCard: _r,
    anthropicTierRoutes: _t,
    providerBudgets: _b,
    ...kept
  } = stored;
  const models = str(values, "verifiedModels")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return {
    payload: {
      ...kept,
      ...(str(values, "defaultProvider")
        ? { defaultProvider: str(values, "defaultProvider") }
        : {}),
      ...(models.length ? { verifiedModels: models } : {}),
      ...(route.every(Boolean)
        ? {
            modelRoutes: {
              fast: route[0],
              standard: route[1],
              quality: route[2],
              escalation: route[3],
            },
          }
        : {}),
      ...(rateCard ? { rateCard } : {}),
      ...(tiers.every(Boolean)
        ? {
            anthropicTierRoutes: {
              fast: tiers[0],
              standard: tiers[1],
              quality: tiers[2],
            },
          }
        : {}),
      ...(providerBudgets ? { providerBudgets } : {}),
    },
  };
}

export function AiProfileEditor({
  path,
  locale,
  scopeLabel,
}: {
  /** "/admin/ai/profile" or "/organizations/:id/ai/profile". */
  path: string;
  locale: Locale;
  scopeLabel: string;
}) {
  const de = locale === "de";
  const profile = useResource<Profile>(path);
  const save = useMutation(profile.refresh);
  const [formError, setFormError] = useState<ProfileFormError | null>(null);
  if (profile.loading && !profile.data)
    return <Loading label={de ? "Wird geladen…" : "Loading…"} />;
  if (!profile.data) return <ResourceError error={profile.error} retry={profile.refresh} />;
  const { data: d, version } = profile.data;
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>
            {de ? "KI-Profil" : "AI profile"} · {scopeLabel}
          </h2>
          <p>
            {de
              ? `Modelle, Routen und Preise als Standard (Version ${version}). Eigene KI-Einstellungen eines Projekts gehen vor. Schlüssel gehören zu den Verbindungen.`
              : `Models, routes and prices as defaults (version ${version}). A project's own AI settings take precedence. Keys belong to connections.`}
          </p>
        </div>
      </div>
      <div className="panel-body">
        {save.success && <Alert kind="success">{de ? "Gespeichert." : "Saved."}</Alert>}
        <DataForm
          fields={profileFields(d, locale)}
          pending={save.pending}
          error={
            formError
              ? profileErrors[formError][de ? "de" : "en"]
              : errorText(save.error, locale)
          }
          submitLabel={de ? "Speichern" : "Save"}
          onSubmit={(v) => {
            const result = profilePayload(d, v);
            if ("error" in result) {
              setFormError(result.error);
              return;
            }
            setFormError(null);
            // The loaded version: a profile changed since (for example its
            // standard models) is refused instead of overwritten.
            void save.run(() => put(`${path}?expectedVersion=${version}`, result.payload));
          }}
        />
      </div>
    </section>
  );
}

type Shares = {
  libraries: Array<{ id: string; name: string }>;
  shares: Array<{
    id: string;
    libraryName: string;
    consumerName: string;
    sourceIds: string[];
    modules: string[];
    generation: number;
  }>;
};

const MODULES = ["support", "assistant"] as const;

export function KnowledgeSharesPanel({
  organizationId,
  projects,
  locale,
}: {
  organizationId: string;
  projects: Array<{ id: string; name: string }>;
  locale: Locale;
}) {
  const de = locale === "de";
  const base = `/organizations/${encodeURIComponent(organizationId)}`;
  const shares = useResource<Shares>(`${base}/knowledge-shares`);
  const action = useMutation(shares.refresh);
  const [creating, setCreating] = useState<"library" | "share" | null>(null);
  const [modules, setModules] = useState<string[]>(["support"]);
  const moduleLabel = (m: string) =>
    m === "support" ? "Support" : de ? "Assistent" : "Assistant";
  if (shares.loading && !shares.data)
    return <Loading label={de ? "Wird geladen…" : "Loading…"} />;
  if (!shares.data) return <ResourceError error={shares.error} retry={shares.refresh} />;
  const libraryIds = new Set(shares.data.libraries.map((l) => l.id));
  const consumers = projects.filter((p) => !libraryIds.has(p.id));
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{de ? "Gemeinsames Wissen" : "Shared knowledge"}</h2>
          <p>
            {de
              ? "Wissensbibliotheken der Organisation. Projekte durchsuchen eine Bibliothek nur mit Freigabe; Belege nennen die Herkunft, und jede Änderung macht frühere Ergebnisse ungültig."
              : "The organization's knowledge libraries. Projects search a library only with a share; evidence names its origin, and any change invalidates earlier results."}
          </p>
        </div>
        <div className="panel-actions">
          <Button variant="outline" size="sm" onClick={() => setCreating("library")}>
            <BookOpen />
            {de ? "Bibliothek anlegen" : "Create library"}
          </Button>
          <Button size="sm" disabled={!shares.data.libraries.length} onClick={() => setCreating("share")}>
            {de ? "Freigeben" : "Share"}
          </Button>
        </div>
      </div>
      {action.error && <Alert kind="error">{errorText(action.error, locale)}</Alert>}
      {shares.data.libraries.length ? (
        <p className="panel-note">
          {de ? "Bibliotheken:" : "Libraries:"}{" "}
          {shares.data.libraries.map((l, i) => (
            <span key={l.id}>
              {i > 0 && ", "}
              <a href={`/p/${encodeURIComponent(l.id)}/knowledge`}>{l.name}</a>
            </span>
          ))}
        </p>
      ) : null}
      {shares.data.shares.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{de ? "Bibliothek" : "Library"}</th>
                <th>{de ? "Projekt" : "Project"}</th>
                <th>{de ? "Module" : "Modules"}</th>
                <th>{de ? "Quellen" : "Sources"}</th>
                <th>
                  <span className="sr-only">{de ? "Aktionen" : "Actions"}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shares.data.shares.map((s) => (
                <tr key={s.id}>
                  <td>{s.libraryName}</td>
                  <td>{s.consumerName}</td>
                  <td>
                    {(s.modules.length ? s.modules : MODULES).map((m) => (
                      <Badge key={m}>{moduleLabel(m)}</Badge>
                    ))}
                  </td>
                  <td>{s.sourceIds.length || (de ? "alle" : "all")}</td>
                  <td className="row-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={action.pending}
                      onClick={() =>
                        void action.run(() =>
                          remove(`${base}/knowledge-shares/${s.id}`),
                        )
                      }
                    >
                      {de ? "Widerrufen" : "Revoke"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title={de ? "Noch keine Freigaben." : "No shares yet."} />
      )}
      {creating === "library" && (
        <Modal
          title={de ? "Bibliothek anlegen" : "Create library"}
          description={
            de
              ? "Eine Bibliothek ist ein eigenes Projekt für gemeinsames Wissen; Quellen pflegst du dort wie gewohnt."
              : "A library is a project of its own for shared knowledge; you manage its sources there as usual."
          }
          onClose={() => setCreating(null)}
        >
          <DataForm
            fields={[{ name: "name", label: "Name", required: true }]}
            pending={action.pending}
            error={errorText(action.error, locale)}
            submitLabel={de ? "Anlegen" : "Create"}
            onSubmit={async (v) => {
              const done = await action.run(() =>
                post(`${base}/knowledge-libraries`, { name: str(v, "name") }),
              );
              if (done) setCreating(null);
            }}
          />
        </Modal>
      )}
      {creating === "share" && (
        <Modal title={de ? "Bibliothek freigeben" : "Share a library"} onClose={() => setCreating(null)}>
          <fieldset className="grant-list">
            <legend>{de ? "Für Module" : "For modules"}</legend>
            {MODULES.map((m) => (
              <label key={m} className="module-role-row">
                <span>{moduleLabel(m)}</span>
                <input
                  type="checkbox"
                  checked={modules.includes(m)}
                  onChange={(e) =>
                    setModules(e.target.checked ? [...modules, m] : modules.filter((x) => x !== m))
                  }
                />
              </label>
            ))}
          </fieldset>
          <DataForm
            fields={[
              {
                name: "library",
                label: de ? "Bibliothek" : "Library",
                type: "select",
                required: true,
                options: shares.data.libraries.map((l) => ({ value: l.id, label: l.name })),
              },
              {
                name: "consumer",
                label: de ? "Projekt" : "Project",
                type: "select",
                required: true,
                options: consumers.map((p) => ({ value: p.id, label: p.name })),
              },
            ]}
            pending={action.pending}
            error={errorText(action.error, locale)}
            submitLabel={de ? "Freigeben" : "Share"}
            onSubmit={async (v) => {
              const done = await action.run(() =>
                post(`${base}/knowledge-shares`, {
                  libraryProjectId: str(v, "library"),
                  consumerProjectId: str(v, "consumer"),
                  modules,
                }),
              );
              if (done) setCreating(null);
            }}
          />
        </Modal>
      )}
    </section>
  );
}
