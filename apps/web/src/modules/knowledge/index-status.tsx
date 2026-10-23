"use client";
import { useState } from "react";
import { RefreshCw, Settings2 } from "lucide-react";
import {
  action,
  collectionPath,
  useMutation,
  useResource,
  when,
  type Entity,
} from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Alert, Badge, Button, Modal } from "@/components/ui/primitives";
import { DataForm, num, str } from "@/platform/ui/form";

// Search index state per knowledge source (plans/knowledge-indexing-repair.md):
// whether its documents can be found now, why not, and the owner's repairs
// (source settings and an idempotent reindex).

export type SourceIndexStatus = {
  sourceId: string;
  name: string;
  state: "pending" | "indexing" | "ready" | "failed" | "stale";
  blockers: string[];
  documents: number;
  chunks: number;
  embeddedChunks: number;
  searchMode: "hybrid" | "lexical" | "none";
  outdatedDocuments: number;
  staleDocuments: number;
  lastIndexedAt: string | null;
  jobs: { pending: number; failed: number; lastError: string | null };
};

type Text = { en: string; de: string };
const STATE: Record<SourceIndexStatus["state"], Text> = {
  pending: { en: "Pending", de: "Ausstehend" },
  indexing: { en: "Indexing", de: "Wird indexiert" },
  ready: { en: "Ready", de: "Bereit" },
  failed: { en: "Failed", de: "Fehlgeschlagen" },
  stale: { en: "Stale", de: "Veraltet" },
};
const MODE: Record<SourceIndexStatus["searchMode"], Text> = {
  hybrid: {
    en: "Semantic + full-text search",
    de: "Semantische + Volltextsuche",
  },
  lexical: {
    en: "Full-text search (no embeddings)",
    de: "Volltextsuche (ohne Embeddings)",
  },
  none: { en: "Not searchable", de: "Nicht durchsuchbar" },
};
const BLOCKERS: Record<string, Text> = {
  generated_authority: {
    en: "Classified as generated content: never used as evidence or search result. Change the authority if the owner curated it.",
    de: "Als generierter Inhalt eingestuft: wird nie als Beleg oder Suchtreffer verwendet. Autorität ändern, wenn der Owner ihn kuratiert hat.",
  },
  source_paused: {
    en: "The source is paused.",
    de: "Die Quelle ist pausiert.",
  },
  model_use_forbidden: {
    en: "Model processing is not allowed: assistants and MCP clients cannot read it.",
    de: "Modellverarbeitung ist nicht erlaubt: Assistenten und MCP-Clients können sie nicht lesen.",
  },
  no_documents: { en: "No documents yet.", de: "Noch keine Dokumente." },
  outdated_generation: {
    en: "Documents belong to an older version of the source settings and are hidden until reindexed.",
    de: "Dokumente gehören zu einer älteren Fassung der Quelleinstellungen und sind bis zur Reindexierung ausgeblendet.",
  },
  stale_documents: {
    en: "Documents are older than the source's freshness window and are hidden from search.",
    de: "Dokumente sind älter als das Frischefenster der Quelle und werden in der Suche ausgeblendet.",
  },
};
const L = (text: Text, locale: Locale) => text[locale] || text.en;

export function stateTone(state: SourceIndexStatus["state"]) {
  return state === "ready"
    ? "success"
    : state === "failed"
      ? "danger"
      : state === "stale"
        ? "warning"
        : "blue";
}

/** The index state of every source of the project (from knowledge-health). */
export function useIndexStatus(projectId: string, revision: number) {
  const health = useResource<{ indexStatus?: SourceIndexStatus[] }>(
    collectionPath(projectId, `knowledge-health?revision=${revision}`),
  );
  return {
    ...health,
    byId: new Map(
      (health.data?.indexStatus ?? []).map((status) => [
        status.sourceId,
        status,
      ]),
    ),
  };
}

export function IndexStateBadge({
  status,
  locale,
}: {
  status: SourceIndexStatus | undefined;
  locale: Locale;
}) {
  if (!status) return null;
  return (
    <Badge tone={stateTone(status.state)}>
      {L(STATE[status.state], locale)}
    </Badge>
  );
}

export function SourceIndexPanel({
  projectId,
  source,
  status,
  isOwner,
  locale,
  timezone,
  onChanged,
}: {
  projectId: string;
  source: Entity;
  status: SourceIndexStatus | undefined;
  isOwner: boolean;
  locale: Locale;
  timezone: string;
  onChanged: () => void;
}) {
  const de = locale === "de";
  const [settings, setSettings] = useState(false);
  const mutation = useMutation(onChanged);
  if (!status) return null;
  return (
    <section
      className="index-status"
      aria-label={de ? "Suchindex" : "Search index"}
    >
      <h3>
        {de ? "Suchindex" : "Search index"}{" "}
        <IndexStateBadge status={status} locale={locale} />
      </h3>
      <dl className="inspector-fields">
        <dt>{de ? "Dokumente" : "Documents"}</dt>
        <dd>{status.documents}</dd>
        <dt>Chunks</dt>
        <dd>{status.chunks}</dd>
        <dt>{de ? "Mit Embedding" : "Embedded"}</dt>
        <dd>
          {status.embeddedChunks} / {status.chunks}
        </dd>
        <dt>{de ? "Suche" : "Search"}</dt>
        <dd>{L(MODE[status.searchMode], locale)}</dd>
        <dt>{de ? "Zuletzt indexiert" : "Last indexed"}</dt>
        <dd>{when(status.lastIndexedAt, locale, timezone)}</dd>
        <dt>{de ? "Jobs offen / fehlgeschlagen" : "Jobs pending / failed"}</dt>
        <dd>
          {status.jobs.pending} / {status.jobs.failed}
        </dd>
      </dl>
      {status.jobs.lastError && (
        <Alert kind="error">
          {de ? "Letzter Fehler: " : "Last error: "}
          <code>{status.jobs.lastError}</code>
        </Alert>
      )}
      {status.blockers
        .filter((code) => code !== "no_documents")
        .map((code) => (
          <Alert key={code} kind="warning">
            {BLOCKERS[code] ? L(BLOCKERS[code]!, locale) : code}
          </Alert>
        ))}
      {isOwner && (
        <div className="stack-actions">
          <Button
            variant="outline"
            disabled={mutation.pending}
            onClick={() =>
              mutation.run(() =>
                action(projectId, "source-reindex", { sourceId: source.id }),
              )
            }
          >
            <RefreshCw data-icon="inline-start" />
            {de ? "Neu indexieren" : "Reindex"}
          </Button>
          <Button variant="outline" onClick={() => setSettings(true)}>
            <Settings2 data-icon="inline-start" />
            {de ? "Quelleinstellungen" : "Source settings"}
          </Button>
        </div>
      )}
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {settings && (
        <Modal
          title={de ? "Quelleinstellungen" : "Source settings"}
          description={
            de
              ? "Ändert, wie die Quelle eingestuft wird und wie lange ihre Dokumente als aktuell gelten. Abhängige Belege und Inhalte werden erneut geprüft; gespeicherte Dokumente werden ohne neuen Import neu indexiert."
              : "Changes how the source is classified and how long its documents count as current. Dependent evidence and content are checked again; stored documents are reindexed without a new import."
          }
          onClose={() => setSettings(false)}
        >
          <DataForm
            fields={[
              {
                name: "authority",
                label: de ? "Autorität" : "Authority",
                type: "select",
                value: String(source.data.authority ?? "research"),
                options: [
                  {
                    value: "official",
                    label: de
                      ? "Offiziell · vom Owner verantwortete Dokumentation"
                      : "Official · documentation the owner stands behind",
                  },
                  {
                    value: "website",
                    label: de
                      ? "Website · öffentliche Website"
                      : "Website · public website",
                  },
                  {
                    value: "research",
                    label: de
                      ? "Recherche · Referenz mit niedriger Priorität"
                      : "Research · lower-priority reference",
                  },
                  {
                    value: "generated",
                    label: de
                      ? "Generiert · nie Beleg, nicht durchsuchbar"
                      : "Generated · never evidence, not searchable",
                  },
                ],
              },
              {
                name: "maxAgeHours",
                label: de
                  ? "Frischefenster (Stunden)"
                  : "Freshness window (hours)",
                type: "number",
                min: 1,
                max: 8760,
                value: Number(source.data.maxAgeHours ?? 168),
                hint: de
                  ? "Dokumente, die länger nicht importiert wurden, gelten als veraltet. Für manuell gepflegte Dokumente ist ein langes Fenster (z. B. 8760 = 1 Jahr) üblich."
                  : "Documents not imported for longer count as stale. Manually maintained documents usually use a long window (for example 8760 = one year).",
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel={de ? "Speichern" : "Save"}
            onCancel={() => setSettings(false)}
            onSubmit={(v) =>
              mutation
                .run(() =>
                  action(projectId, "source-settings", {
                    sourceId: source.id,
                    authority: str(v, "authority"),
                    maxAgeHours: num(v, "maxAgeHours"),
                  }),
                )
                .then((result) => {
                  if (result) setSettings(false);
                })
            }
          />
        </Modal>
      )}
    </section>
  );
}
