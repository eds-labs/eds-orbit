"use client";
import { useState } from "react";
import { BookOpen } from "lucide-react";
import { post, put, remove, useMutation, useResource } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Alert, Badge, Button, Empty, Loading, Modal } from "@/components/ui/primitives";
import { ResourceError } from "@/platform/ui/collection";
import { DataForm, str } from "@/platform/ui/form";
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
  };
};

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
  const [jsonError, setJsonError] = useState<string | null>(null);
  if (profile.loading && !profile.data)
    return <Loading label={de ? "Wird geladen…" : "Loading…"} />;
  if (!profile.data) return <ResourceError error={profile.error} retry={profile.refresh} />;
  const d = profile.data.data;
  const routes = d.modelRoutes;
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>
            {de ? "KI-Profil" : "AI profile"} · {scopeLabel}
          </h2>
          <p>
            {de
              ? `Modelle, Routen und Preise als Standard (Version ${profile.data.version}). Eigene KI-Einstellungen eines Projekts gehen vor. Schlüssel gehören zu den Verbindungen.`
              : `Models, routes and prices as defaults (version ${profile.data.version}). A project's own AI settings take precedence. Keys belong to connections.`}
          </p>
        </div>
      </div>
      <div className="panel-body">
        {save.success && <Alert kind="success">{de ? "Gespeichert." : "Saved."}</Alert>}
        <DataForm
          fields={[
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
            {
              name: "rateCard",
              label: de ? "Preise (JSON: Modell → USD-Micros je Mio. Tokens)" : "Rate card (JSON: model → USD micros per million tokens)",
              type: "textarea",
              value: d.rateCard ? JSON.stringify(d.rateCard, null, 2) : "",
            },
          ]}
          pending={save.pending}
          error={jsonError ?? errorText(save.error, locale)}
          submitLabel={de ? "Speichern" : "Save"}
          onSubmit={(v) => {
            setJsonError(null);
            let rateCard: unknown;
            try {
              rateCard = str(v, "rateCard") ? JSON.parse(str(v, "rateCard")) : undefined;
            } catch {
              setJsonError(de ? "Die Preise sind kein gültiges JSON." : "The rate card is not valid JSON.");
              return;
            }
            const models = str(v, "verifiedModels")
              .split(",")
              .map((m) => m.trim())
              .filter(Boolean);
            const route = ["fast", "standard", "quality", "escalation"].map((k) => str(v, k));
            void save.run(() =>
              put(path, {
                ...(str(v, "defaultProvider") ? { defaultProvider: str(v, "defaultProvider") } : {}),
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
                ...(d.taskRoutes ? { taskRoutes: d.taskRoutes } : {}),
              }),
            );
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

