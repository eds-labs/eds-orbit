"use client";
import { FactWithdrawal, IndexManagement } from "./operator-tools";
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  BookOpen,
  Plus,
  Search,
  FileText,
  ArrowRight,
  Upload,
  ShieldCheck,
  Clock,
  Link2,
  RefreshCw,
  Pause,
  Trash2,
  FlaskConical,
  Download,
} from "lucide-react";
import {
  action,
  collectionPath,
  post,
  useMutation,
  useResource,
  value,
  when,
  type Entity,
} from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Input,
  Loading,
  Modal,
  Status,
  Tabs,
} from "./ui/primitives";
import {
  DataForm,
  csv,
  dateField,
  iso,
  num,
  options,
  str,
  type FormField,
  type FormValues,
} from "./form";
import { useWorkspace } from "./workspace-context";
import {
  EntityRows,
  EvidenceItems,
  PageHead,
  ResourceError,
  useCollection,
} from "./work";
type Health = Record<string, unknown>;
export function Knowledge() {
  const { t, locale, project, revision, canEdit, isOwner } = useWorkspace();
  const [tab, setTab] = useState("overview"),
    [add, setAdd] = useState(false);
  const tabs = [
    ["overview", "Overview"],
    ["sources", t("sources")],
    ["facts", t("factTab")],
    ["import", "Import"],
    ["conflicts", "Conflicts"],
    ["library", t("library")],
    ["health", t("health")],
    ["inspector", t("inspector")],
    ["impact", t("impact")],
  ].map(([key, label]) => ({ key, label }));
  return (
    <>
      <PageHead title={t("knowledge")} description={t("knowledgeHint")}>
        {isOwner && (tab === "sources" || tab === "facts") && (
          <Button onClick={() => setAdd(true)}>
            <Plus data-icon="inline-start" />
            {tab === "facts" ? t("addFact") : t("addSource")}
          </Button>
        )}
      </PageHead>
      <Tabs
        tabs={tabs}
        value={tab}
        onChange={(s) => {
          setTab(s);
          setAdd(false);
        }}
      />
      {tab === "overview" ? (
        <KnowledgeHealth impact={false} />
      ) : tab === "sources" ? (
        <Sources />
      ) : tab === "facts" ? (
        <Facts />
      ) : tab === "import" ? (
        <ImportCenter />
      ) : tab === "conflicts" ? (
        <Facts />
      ) : tab === "library" ? (
        <Library />
      ) : tab === "inspector" ? (
        <Inspector />
      ) : (
        <KnowledgeHealth impact={tab === "impact"} />
      )}
      {tab === "sources" && (
        <div className="knowledge-principles">
          <div>
            <FileText />
            <div>
              <strong>
                {locale === "de" ? "Strukturierte Fakten" : "Structured facts"}
              </strong>
              <p>
                {locale === "de"
                  ? "Von deinem Team bestätigte Werte"
                  : "Values reviewed by your team"}
              </p>
            </div>
          </div>
          <div>
            <BookOpen />
            <div>
              <strong>
                {locale === "de" ? "Dokumentbibliothek" : "Document library"}
              </strong>
              <p>
                {locale === "de"
                  ? "Freigegebener Kontext mit Versionen"
                  : "Approved context with version history"}
              </p>
            </div>
          </div>
          <div>
            <ShieldCheck />
            <div>
              <strong>Marketing Memory</strong>
              <p>
                {locale === "de"
                  ? "Beobachtungen, keine Produktfakten"
                  : "Observations, never product facts"}
              </p>
            </div>
          </div>
        </div>
      )}
      <Alert>
        {locale === "de"
          ? "Wissen und generierte Inhalte bleiben getrennt."
          : "Knowledge and generated content stay separate."}
      </Alert>
      {add &&
        (tab === "sources" ? (
          <SourceEditor onClose={() => setAdd(false)} />
        ) : (
          <FactEditor onClose={() => setAdd(false)} />
        ))}
    </>
  );
}
function Sources() {
  const { t, locale, project, canEdit, isOwner, refresh } = useWorkspace();
  const resource = useCollection("sources");
  const [search, setSearch] = useState(""),
    [selected, setSelected] = useState<Entity | null>(null),
    [create, setCreate] = useState(false),
    [importing, setImporting] = useState(false),
    [revoke, setRevoke] = useState(false);
  const mutation = useMutation(() => {
    refresh();
    resource.refresh();
  });
  const current =
    resource.data?.items.find((e) => e.id === selected?.id) || selected;
  const items = (resource.data?.items || []).filter((e) =>
    value(e, "name").toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <ResourceError error={resource.error} retry={resource.refresh} />
      <div className="knowledge-grid">
        <section className="panel">
          <div className="panel-head">
            <h2>{t("yourSources")}</h2>
            <div className="search-field">
              <Search />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label={t("searchSources")}
                placeholder={t("searchSources")}
              />
            </div>
          </div>
          {resource.loading ? (
            <Loading />
          ) : items.length ? (
            <div className="source-list">
              {items.map((e) => (
                <button
                  key={e.id}
                  className={cn(
                    "source-row",
                    current?.id === e.id && "source-selected",
                  )}
                  onClick={() => setSelected(e)}
                >
                  <span className="source-icon">
                    {e.data.type === "website" || e.data.type === "gitbook" ? (
                      <Link2 />
                    ) : (
                      <FileText />
                    )}
                  </span>
                  <div>
                    <strong>{value(e, "name")}</strong>
                    <p>
                      {value(e, "type")} ·{" "}
                      {e.data.publicUse
                        ? locale === "de"
                          ? "Öffentlich"
                          : "Public"
                        : locale === "de"
                          ? "Intern"
                          : "Internal"}
                    </p>
                    <small>
                      {t("lastFetched")}:{" "}
                      {when(
                        e.data.lastSuccessfulSyncAt ||
                          e.data.last_successful_sync_at,
                        locale,
                        project.timezone,
                      )}
                    </small>
                  </div>
                  <Status value={e.data.status} />
                  <ArrowRight />
                </button>
              ))}
            </div>
          ) : (
            <Empty
              title={search ? t("emptySearch") : t("sourceTruth")}
              description={t("sourceHint")}
              icon={BookOpen}
            >
              {isOwner && (
                <Button onClick={() => setCreate(true)}>
                  {t("addSource")}
                </Button>
              )}
            </Empty>
          )}
        </section>
        <aside className="inspector-panel">
          <h2>{current ? value(current, "name") : t("sourceDetails")}</h2>
          <p>
            {current
              ? `${value(current, "type")} · ${value(current, "authority")} · v${current.version}`
              : t("sourceSelect")}
          </p>
          {current && (
            <>
              <Status value={current.data.status} />
              <div className="rights-flags">
                <Badge tone={current.data.publicUse ? "success" : "neutral"}>
                  {current.data.publicUse ? "Public use" : "Internal only"}
                </Badge>
                <Badge tone={current.data.modelUse ? "blue" : "warning"}>
                  {current.data.modelUse
                    ? "Model processing allowed"
                    : "No model processing"}
                </Badge>
              </div>
              <h3>{t("scope")}</h3>
              <p className="break-all">
                {Array.isArray(current.data.allowedOrigins)
                  ? current.data.allowedOrigins.join(", ")
                  : "—"}
              </p>
              <p>
                {Array.isArray(current.data.allowedPaths)
                  ? current.data.allowedPaths.join(", ")
                  : "—"}
              </p>
            </>
          )}
          <dl className="inspector-fields">
            <dt>{t("lastFetched")}</dt>
            <dd>
              {when(
                current?.data.lastSuccessfulSyncAt ||
                  current?.data.last_successful_sync_at,
                locale,
                project.timezone,
              )}
            </dd>
            <dt>{t("lastIndexed")}</dt>
            <dd>
              {when(current?.data.lastIndexedAt, locale, project.timezone)}
            </dd>
            <dt>{t("contentVerified")}</dt>
            <dd>{when(current?.data.verifiedAt, locale, project.timezone)}</dd>
          </dl>
          {current && (
            <div className="stack-actions">
              {canEdit && current.data.status === "active" && (
                <Button variant="outline" onClick={() => setImporting(true)}>
                  <Upload data-icon="inline-start" />
                  {t("import")}
                </Button>
              )}
              {isOwner && current.data.status !== "revoked" && (
                <>
                  <Button
                    variant="outline"
                    disabled={mutation.pending}
                    onClick={() =>
                      mutation.run(() =>
                        action(project.id, "source-pause", {
                          sourceId: current.id,
                          paused: current.data.status !== "paused",
                        }),
                      )
                    }
                  >
                    <Pause data-icon="inline-start" />
                    {current.data.status === "paused"
                      ? "Resume source"
                      : "Pause source"}
                  </Button>
                  <Button variant="destructive" onClick={() => setRevoke(true)}>
                    <Trash2 data-icon="inline-start" />
                    {locale === "de" ? "Zugriff widerrufen" : "Revoke access"}
                  </Button>
                </>
              )}
            </div>
          )}
          {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
          {mutation.success && <Alert kind="success">{t("success")}</Alert>}
        </aside>
      </div>
      {create && <SourceEditor onClose={() => setCreate(false)} />}
      {importing && current && (
        <ImportSource source={current} onClose={() => setImporting(false)} />
      )}
      {revoke && current && (
        <Modal
          title={locale === "de" ? "Quelle widerrufen" : "Revoke this source"}
          description={
            locale === "de"
              ? "Belege, Memory und abhängige Inhalte werden erneut geprüft. Dieser Schritt entzieht den Zugriff."
              : "Evidence, memory and dependent content are invalidated. This withdraws access to the source."
          }
          onClose={() => setRevoke(false)}
        >
          <p>
            <strong>{value(current, "name")}</strong> · v{current.version}
          </p>
          <DataForm
            fields={[
              {
                name: "confirm",
                label:
                  locale === "de"
                    ? "Ich bestätige den Widerruf dieser Quelle."
                    : "I confirm revoking access to this source.",
                type: "checkbox",
                required: true,
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel={locale === "de" ? "Jetzt widerrufen" : "Revoke source"}
            onCancel={() => setRevoke(false)}
            onSubmit={() =>
              mutation
                .run(() =>
                  action(project.id, "revoke-source", { sourceId: current.id }),
                )
                .then((result) => {
                  if (result) setRevoke(false);
                })
            }
          />
        </Modal>
      )}
    </>
  );
}
function SourceEditor({ onClose }: { onClose: () => void }) {
  const { project, t, locale, refresh } = useWorkspace();
  const mutation = useMutation(() => {
    refresh();
    onClose();
  });
  const de = locale === "de";
  const fields: FormField[] = [
    { name: "name", label: t("name"), required: true },
    {
      name: "type",
      label: de ? "Quellentyp" : "Source type",
      type: "select",
      value: "manual",
      options: options(["manual", "file", "website", "gitbook"]),
    },
    {
      name: "authority",
      label: de ? "Quellenklasse" : "Source authority",
      type: "select",
      value: "research",
      options: options(["official", "website", "research", "generated"]),
      hint: de
        ? "Verifikation bleibt eine serverseitige Prüfung."
        : "Verification remains a server-side decision.",
    },
    {
      name: "allowedOrigins",
      label: de
        ? "Erlaubte Ursprünge (kommagetrennt)"
        : "Allowed origins (comma separated)",
      placeholder: "https://example.com",
      hint: de
        ? "Für Websites und GitBook ist ein konkreter Ursprung erforderlich."
        : "A concrete origin is required for websites and GitBook.",
    },
    {
      name: "allowedPaths",
      label: de
        ? "Erlaubte Pfade (kommagetrennt)"
        : "Allowed paths (comma separated)",
      value: "/",
    },
    {
      name: "maxAgeHours",
      label: de ? "Frischegrenze in Stunden" : "Freshness limit in hours",
      type: "number",
      required: true,
      min: 1,
      max: 8760,
      value: 168,
    },
    {
      name: "syncEveryHours",
      label: de
        ? "Automatischer Abruf alle X Stunden (optional)"
        : "Automatic fetch every X hours (optional)",
      type: "number",
      min: 1,
      max: 168,
      showWhen: { name: "type", values: ["website", "gitbook"] },
      hint: de
        ? "Leer lassen für manuellen Abruf. Nur zuvor importierte, erlaubte URLs werden erneut abgerufen."
        : "Leave empty for manual fetching. Only previously imported, allowed URLs are fetched again.",
    },
    { name: "publicUse", label: t("publicUse"), type: "checkbox" },
    { name: "modelUse", label: t("modelUse"), type: "checkbox" },
  ];
  return (
    <Modal title={t("addSource")} onClose={onClose}>
      <DataForm
        fields={fields}
        pending={mutation.pending}
        error={mutation.error}
        t={t}
        onCancel={onClose}
        submitLabel={t("addSource")}
        onSubmit={(v) =>
          mutation
            .run(() =>
              post(collectionPath(project.id, "sources"), {
                name: str(v, "name"),
                type: str(v, "type"),
                authority: str(v, "authority"),
                allowedOrigins: csv(v, "allowedOrigins"),
                allowedPaths: csv(v, "allowedPaths"),
                maxAgeHours: num(v, "maxAgeHours"),
                ...(str(v, "syncEveryHours")
                  ? { syncEveryHours: num(v, "syncEveryHours") }
                  : {}),
                publicUse: v.publicUse === true,
                modelUse: v.modelUse === true,
                status: "active",
                generation: 1,
              }),
            )
            .then(() => {})
        }
      />
    </Modal>
  );
}
function ImportSource({
  source,
  onClose,
}: {
  source: Entity;
  onClose: () => void;
}) {
  const { project, t, locale, refresh } = useWorkspace();
  const mutation = useMutation(() => {
    refresh();
    onClose();
  });
  const [file, setFile] = useState<File | null>(null),
    [fileError, setFileError] = useState<string | null>(null);
  const url = source.data.type === "website" || source.data.type === "gitbook";
  const allowedMimes = [
    "text/plain",
    "text/markdown",
    "text/html",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ];
  return (
    <Modal
      title={`${t("import")} · ${value(source, "name")}`}
      description={
        locale === "de"
          ? "Quelleninhalte werden als Daten verarbeitet, niemals als Systemanweisungen."
          : "Source content is processed as data, never as system instructions."
      }
      onClose={onClose}
    >
      {!url && (
        <div className="file-upload">
          <label htmlFor="source-file">
            {locale === "de"
              ? "Datei importieren (optional, maximal 1 MB)"
              : "Import file (optional, maximum 1 MB)"}
          </label>
          <Input
            id="source-file"
            type="file"
            accept=".txt,.md,.html,.pdf,.docx"
            onChange={(e) => {
              const next = e.target.files?.[0] || null;
              if (next && next.size > 1_000_000) {
                setFileError("File exceeds the 1 MB upload limit.");
                setFile(null);
                e.target.value = "";
                return;
              }
              setFileError(null);
              setFile(next);
            }}
          />
          <p>TXT · Markdown · HTML · PDF · DOCX</p>
        </div>
      )}
      {fileError && <Alert kind="error">{fileError}</Alert>}
      <DataForm
        key={file?.name || "text"}
        fields={
          url
            ? [
                {
                  name: "url",
                  label: "Approved source URL",
                  type: "url",
                  required: true,
                },
              ]
            : [
                {
                  name: "externalId",
                  label:
                    locale === "de"
                      ? "Stabile Dokumentkennung"
                      : "Stable document identifier",
                  required: true,
                  value: file?.name,
                  hint: "Reuse this identifier to import a new version.",
                },
                {
                  name: "title",
                  label: t("title"),
                  required: true,
                  value: file?.name,
                },
                ...(!file
                  ? [
                      {
                        name: "text",
                        label:
                          locale === "de" ? "Dokumenttext" : "Document text",
                        type: "textarea" as const,
                        required: true,
                        max: 1000000,
                      },
                    ]
                  : []),
                {
                  name: "language",
                  label: t("language"),
                  type: "select",
                  value: project.language,
                  options: options(["en", "de"]),
                },
              ]
        }
        pending={mutation.pending}
        error={mutation.error}
        t={t}
        onCancel={onClose}
        submitLabel={t("import")}
        onSubmit={(v) =>
          mutation
            .run(async () => {
              if (url)
                return action(project.id, "import", {
                  sourceId: source.id,
                  url: str(v, "url"),
                  language: project.language,
                });
              const extension = file?.name.split(".").pop()?.toLowerCase();
              const mimeType = file
                ? allowedMimes.includes(file.type)
                  ? file.type
                  : extension === "md"
                    ? "text/markdown"
                    : extension === "txt"
                      ? "text/plain"
                      : extension === "html"
                        ? "text/html"
                        : extension === "pdf"
                          ? "application/pdf"
                          : extension === "docx"
                            ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                            : ""
                : "text/plain";
              if (!mimeType) throw new Error("Unsupported document type.");
              return action(project.id, "import", {
                sourceId: source.id,
                externalId: str(v, "externalId"),
                title: str(v, "title"),
                language: str(v, "language"),
                mimeType,
                ...(file
                  ? {
                      base64: btoa(
                        Array.from(
                          new Uint8Array(await file.arrayBuffer()),
                          (byte) => String.fromCharCode(byte),
                        ).join(""),
                      ),
                    }
                  : { text: str(v, "text") }),
              });
            })
            .then(() => {})
        }
      />
    </Modal>
  );
}
function ImportCenter() {
  const { project, locale, refresh, isOwner } = useWorkspace();
  const history = useCollection("knowledge_imports");
  const [payload, setPayload] = useState(JSON.stringify({
    name: "Product documentation", sourceType: "url_list", authority: "website", publicUse: false, modelUse: false,
    allowedOrigins: [], allowedPaths: ["/"], maxAgeHours: 168,
    documents: [{ externalId: "page-1", title: "Page title", text: "Paste Markdown, TXT, HTML, or extracted file text here.", mimeType: "text/markdown", language: "en", selected: true }], facts: [],
  }, null, 2));
  const [preview, setPreview] = useState<Record<string, any> | null>(null);
  const mutation = useMutation(() => refresh());
  const download = (name: string, content: string) => {
    const a = document.createElement("a"); a.href = `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`; a.download = name; a.click();
  };
  const parsed = () => JSON.parse(payload);
  return <section className="panel stack-gap">
    <div className="panel-head"><div><h2>{locale === "de" ? "Knowledge Import Center" : "Knowledge Import Center"}</h2><p>{locale === "de" ? "Vorschau und Validierung erfolgen vor dem Commit. Historische Inhalte bleiben getrennt von Faktenbelegen." : "Preview and validation happen before commit. Historical content stays separate from factual evidence."}</p></div></div>
    <div className="form-actions">
      <Button variant="outline" onClick={() => download("orbit-verified-facts.csv", "key,value,valueType,language,validFrom,publicUse,modelUse\nproduct.status,active,status,en,2026-01-01T00:00:00.000Z,false,false\n")}><Download data-icon="inline-start" />CSV facts template</Button>
      <Button variant="outline" onClick={() => download("orbit-verified-facts.json", JSON.stringify({ facts: [{ key: "product.status", value: "active", valueType: "status", language: "en", validFrom: "2026-01-01T00:00:00.000Z", publicUse: false, modelUse: false }] }, null, 2))}><Download data-icon="inline-start" />JSON facts template</Button>
    </div>
    <label htmlFor="knowledge-import-payload">Import payload (website/GitBook URLs may be discovered and selected by the importer; files use text or base64 content)</label>
    <textarea id="knowledge-import-payload" className="input min-h-80 font-mono text-xs" value={payload} onChange={(event) => { setPayload(event.target.value); setPreview(null); }} aria-describedby="knowledge-import-help" />
    <p id="knowledge-import-help">Source types: website, gitbook, url, url_list, file, verified_facts, historical.</p>
    {preview && <Alert kind={preview.ready ? "success" : "warning"}>{preview.ready ? `${preview.documents?.length ?? 0} documents and ${preview.factCount ?? 0} facts are ready.` : `Resolve: ${(preview.errors ?? []).map((x: any) => x.code).join(", ")}`}</Alert>}
    {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
    <div className="form-actions">
      <Button variant="outline" disabled={mutation.pending} onClick={() => mutation.run(() => action(project.id, "knowledge-import-preview", parsed())).then((value) => { if (value) setPreview(value as Record<string, any>); })}>Preview import</Button>
      <Button disabled={!isOwner || !preview?.ready || mutation.pending} onClick={() => mutation.run(() => action(project.id, "knowledge-import-commit", parsed())).then(() => setPreview(null))}>Commit selected import</Button>
    </div>
    <h3>{locale === "de" ? "Import-Verlauf" : "Import history"}</h3>
    {history.data?.items.length ? <EntityRows items={history.data.items} fields={["name", "sourceType", "status", "completed", "failed", "completedAt"]} /> : <p>{locale === "de" ? "Noch keine Importe in diesem Projekt." : "No imports for this project yet."}</p>}
  </section>;
}
function Facts() {
  const { t, locale, project, isOwner } = useWorkspace();
  const resource = useCollection("facts");
  const [selected, setSelected] = useState<Entity | null>(null),
    [editing, setEditing] = useState(false),
    [create, setCreate] = useState(false),
    [search, setSearch] = useState("");
  const items = (resource.data?.items || []).filter((e) =>
    `${value(e, "key")} ${value(e, "value")}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="filter-bar">
        <div className="search-field">
          <Search />
          <Input
            aria-label="Search facts"
            placeholder={locale === "de" ? "Fakten suchen" : "Search facts"}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      <ResourceError error={resource.error} retry={resource.refresh} />
      {resource.loading ? (
        <Loading />
      ) : (
        <section className="panel">
          {items.length ? (
            <EntityRows
              items={items}
              fields={["key", "value", "status", "updatedAt"]}
              onSelect={setSelected}
            />
          ) : (
            <Empty
              icon={ShieldCheck}
              title={
                locale === "de"
                  ? "Bestätige, was wirklich gilt"
                  : "Make the important facts explicit"
              }
              description={
                locale === "de"
                  ? "Preise, Termine und Produktstatus mit Gültigkeit und Herkunft."
                  : "Prices, dates and product status, with validity and provenance."
              }
            >
              {isOwner && (
                <Button onClick={() => setCreate(true)}>{t("addFact")}</Button>
              )}
            </Empty>
          )}
        </section>
      )}
      {selected && !editing && (
        <Modal title={value(selected, "key")} onClose={() => setSelected(null)}>
          <div className="detail-summary">
            <Status value={selected.data.status} />
            <Badge>Version {selected.version}</Badge>
          </div>
          <h2 className="fact-value">
            {value(selected, "value")} {value(selected, "currency", "")}{" "}
            {value(selected, "unit", "")}
          </h2>
          <dl className="detail-grid">
            <dt>Source</dt>
            <dd>{value(selected, "sourceId")}</dd>
            <dt>Valid from</dt>
            <dd>{when(selected.data.validFrom, locale, project.timezone)}</dd>
            <dt>Valid until</dt>
            <dd>{when(selected.data.validUntil, locale, project.timezone)}</dd>
            <dt>Verified at</dt>
            <dd>{when(selected.data.verifiedAt, locale, project.timezone)}</dd>
            <dt>Verified by</dt>
            <dd>{value(selected, "verifiedBy")}</dd>
            <dt>Language / market</dt>
            <dd>
              {value(selected, "language")} / {value(selected, "market")}
            </dd>
            <dt>Public use</dt>
            <dd>{selected.data.publicUse ? "Allowed" : "Not permitted"}</dd>
            <dt>Model processing</dt>
            <dd>{selected.data.modelUse ? "Allowed" : "Not permitted"}</dd>
          </dl>
          <FactWithdrawal entity={selected} onDone={() => setSelected(null)} />
          {isOwner && (
            <div className="form-actions">
              <Button onClick={() => setEditing(true)}>
                {locale === "de"
                  ? "Korrigierte Version erstellen"
                  : "Create corrected version"}
              </Button>
            </div>
          )}
        </Modal>
      )}
      {(create || editing) && (
        <FactEditor
          entity={editing ? selected || undefined : undefined}
          onClose={() => {
            setCreate(false);
            setEditing(false);
            setSelected(null);
          }}
        />
      )}
    </>
  );
}
function FactEditor({
  entity,
  onClose,
}: {
  entity?: Entity;
  onClose: () => void;
}) {
  const { project, t, locale, isOwner, refresh } = useWorkspace();
  const sources = useCollection("sources");
  const facts = useCollection("facts");
  const mutation = useMutation(() => {
    refresh();
    onClose();
  });
  const d = entity?.data;
  const de = locale === "de";
  const resolving = d?.status === "conflicting";
  const conflicts = resolving
    ? (facts.data?.items || []).filter((fact) => {
        const other = fact.data;
        return (
          ["verified", "conflicting"].includes(String(other.status)) &&
          other.key === d.key &&
          other.language === d.language &&
          (other.market || "") === (d.market || "") &&
          Date.parse(String(other.validFrom)) <=
            (d.validUntil ? Date.parse(String(d.validUntil)) : Infinity) &&
          Date.parse(String(d.validFrom)) <=
            (other.validUntil ? Date.parse(String(other.validUntil)) : Infinity)
        );
      })
    : [];
  const browserDate = (input: unknown) => {
    if (!input) return undefined;
    const date = new Date(String(input));
    return Number.isNaN(date.getTime())
      ? undefined
      : new Date(date.getTime() - date.getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16);
  };
  const fields: FormField[] = [
    {
      name: "key",
      label: de ? "Fachschlüssel" : "Fact key",
      required: true,
      value: d?.key as string,
      placeholder: "product.availability",
    },
    {
      name: "value",
      label: de ? "Wert" : "Value",
      required: true,
      value: d?.value as string,
    },
    {
      name: "valueType",
      label: de ? "Werttyp" : "Value type",
      type: "select",
      value: String(d?.valueType || "text"),
      options: options(["text", "decimal", "date", "status", "url"]),
    },
    {
      name: "currency",
      label: de
        ? "Währung (für Dezimalpreise)"
        : "Currency (for decimal prices)",
      value: d?.currency as string,
      placeholder: "EUR",
    },
    { name: "unit", label: de ? "Einheit" : "Unit", value: d?.unit as string },
    {
      name: "language",
      label: t("language"),
      type: "select",
      value: String(d?.language || project.language),
      options: options(["en", "de"]),
    },
    {
      name: "market",
      label: de ? "Markt / Geltungsbereich" : "Market / scope",
      value: d?.market as string,
    },
    {
      name: "sourceId",
      label: de ? "Belegquelle" : "Supporting source",
      type: "select",
      required: true,
      value: d?.sourceId as string,
      options: (sources.data?.items || [])
        .filter((s) => s.data.status === "active")
        .map((s) => ({ value: s.id, label: value(s, "name") })),
    },
    {
      ...dateField(
        "validFrom",
        de ? "Gültig ab (Browserzeit)" : "Valid from (browser time)",
      ),
      value: browserDate(d?.validFrom),
    },
    {
      ...dateField(
        "validUntil",
        de ? "Gültig bis (optional)" : "Valid until (optional)",
        false,
      ),
      value: browserDate(d?.validUntil),
    },
    {
      name: "status",
      label: de ? "Reviewstatus" : "Review status",
      type: "select",
      value: resolving ? "verified" : "candidate",
      options: options(
        resolving
          ? ["verified"]
          : isOwner
            ? ["candidate", "verified"]
            : ["candidate"],
      ),
    },
    {
      name: "publicUse",
      label: t("publicUse"),
      type: "checkbox",
      value: Boolean(d?.publicUse),
    },
    {
      name: "modelUse",
      label: t("modelUse"),
      type: "checkbox",
      value: Boolean(d?.modelUse),
    },
  ];
  if (resolving)
    fields.push({
      name: "confirmResolution",
      type: "checkbox",
      required: true,
      label: de
        ? "Ich bestätige diesen Wert als maßgeblich und ersetze alle aufgeführten Konfliktversionen."
        : "I confirm this authoritative value and supersede every conflict version listed above.",
    });
  return (
    <Modal
      title={entity ? (de ? "Fakt korrigieren" : "Correct fact") : t("addFact")}
      onClose={onClose}
    >
      {resolving && (
        <>
          <Alert kind="warning">
            {de
              ? "Alle überlappenden Werte dieses Schlüssels müssen gemeinsam aufgelöst werden. Die bisherigen Versionen bleiben im Verlauf erhalten."
              : "All overlapping values for this key must be resolved together. Previous versions remain in the history."}
          </Alert>
          <ul className="blocker-list">
            {conflicts.map((fact) => (
              <li key={fact.id}>
                {value(fact, "value")} {value(fact, "currency", "")} · version{" "}
                {fact.version} · {value(fact, "status")}
              </li>
            ))}
          </ul>
        </>
      )}
      <ResourceError error={facts.error} retry={facts.refresh} />
      {resolving && facts.loading ? (
        <Loading />
      ) : (
        <DataForm
          fields={fields}
          pending={mutation.pending}
          error={mutation.error}
          t={t}
          onCancel={onClose}
          submitLabel={t("save")}
          onSubmit={(v) =>
            mutation
              .run(() =>
                post(collectionPath(project.id, "facts"), {
                  key: str(v, "key"),
                  value: str(v, "value"),
                  valueType: str(v, "valueType"),
                  ...(str(v, "currency")
                    ? { currency: str(v, "currency") }
                    : {}),
                  ...(str(v, "unit") ? { unit: str(v, "unit") } : {}),
                  language: str(v, "language"),
                  ...(str(v, "market") ? { market: str(v, "market") } : {}),
                  sourceId: str(v, "sourceId"),
                  validFrom: iso(v, "validFrom"),
                  ...(str(v, "validUntil")
                    ? { validUntil: iso(v, "validUntil") }
                    : {}),
                  status: str(v, "status"),
                  publicUse: v.publicUse === true,
                  modelUse: v.modelUse === true,
                  ...(resolving
                    ? { resolveConflictIds: conflicts.map((fact) => fact.id) }
                    : entity
                      ? { supersedesId: entity.id }
                      : {}),
                }),
              )
              .then(() => {})
          }
        />
      )}
    </Modal>
  );
}
function Library() {
  const { project, revision, t, locale } = useWorkspace();
  const resource = useResource<{ items: Array<Record<string, unknown>> }>(
    collectionPath(project.id, `documents?revision=${revision}`),
  );
  const sources = useCollection("sources");
  const documents = (resource.data?.items || []).map((raw) => {
    const versions = Array.isArray(raw.versions)
      ? (raw.versions as Array<Record<string, unknown>>)
      : [];
    const active =
      versions.find((v) => v.id === raw.activeVersionId) || versions[0] || {};
    const source = sources.data?.items.find((s) => s.id === raw.sourceId);
    return {
      id: String(raw.id),
      projectId: project.id,
      workspaceId: project.workspaceId,
      kind: "document",
      version: Number(active.version || 1),
      createdAt: String(raw.createdAt || ""),
      updatedAt: String(raw.updatedAt || ""),
      data: {
        ...active,
        status: active.state || "unknown",
        canonicalUrl: raw.canonicalUrl,
        sourceId: raw.sourceId,
        publicUse: source?.data.publicUse,
        versions,
        chunks: active.chunks,
      },
    } as Entity;
  });
  const [selected, setSelected] = useState<Entity | null>(null);
  return (
    <>
      <ResourceError error={resource.error} retry={resource.refresh} />
      {resource.loading ? (
        <Loading />
      ) : (
        <section className="panel">
          {documents.length ? (
            <EntityRows
              items={documents}
              fields={["title", "language", "status", "updatedAt"]}
              onSelect={setSelected}
            />
          ) : (
            <Empty
              icon={BookOpen}
              title={
                locale === "de"
                  ? "Deine Dokumentbibliothek ist leer"
                  : "Your document library is empty"
              }
              description={
                locale === "de"
                  ? "Importiere freigegebenen Text über eine Quelle."
                  : "Import approved text through a source to see its version history."
              }
            />
          )}
        </section>
      )}
      {selected && (
        <Modal
          title={value(selected, "title")}
          onClose={() => setSelected(null)}
          wide
        >
          <div className="detail-summary">
            <Status value={selected.data.status} />
            <Badge>{selected.data.publicUse ? "Public" : "Internal"}</Badge>
            <span>Version {selected.version}</span>
          </div>
          <p>{value(selected, "canonicalUrl", "")}</p>
          <article className="content-preview">
            {value(selected, "text", value(selected, "preview", ""))}
          </article>
          <h3>Version history</h3>
          {Array.isArray(selected.data.versions) ? (
            selected.data.versions.map((v, i) => (
              <div className="history-row" key={i}>
                {Object.entries(v as Record<string, unknown>)
                  .filter(([key]) =>
                    ["version", "createdAt", "contentHash", "status"].includes(
                      key,
                    ),
                  )
                  .map(([key, x]) => (
                    <span key={key}>
                      {key}: {String(x)}
                    </span>
                  ))}
              </div>
            ))
          ) : (
            <p>
              {locale === "de"
                ? "Noch keine älteren Versionen."
                : "No older versions available."}
            </p>
          )}
          <h3>Extracted passages</h3>
          {Array.isArray(selected.data.chunks) ? (
            selected.data.chunks.map((c, i) => (
              <div className="chunk" key={i}>
                <small>
                  {String(
                    (c as Record<string, unknown>).anchor || `Passage ${i + 1}`,
                  )}
                </small>
                <p>{String((c as Record<string, unknown>).text || "")}</p>
              </div>
            ))
          ) : (
            <p>No indexed passages available.</p>
          )}
        </Modal>
      )}
    </>
  );
}
function KnowledgeHealth({ impact = false }: { impact?: boolean }) {
  const { project, revision, locale, isOwner } = useWorkspace();
  const resource = useResource<Health>(
    collectionPath(project.id, `knowledge-health?revision=${revision}`),
  );
  const keys = impact
    ? ["impacts"]
    : [
        "conflicts",
        "expiredFacts",
        "missingEvidence",
        "failedImports",
        "staleSources",
      ];
  return (
    <>
      {!impact && isOwner && <IndexManagement />}
      <ResourceError error={resource.error} retry={resource.refresh} />
      {resource.loading ? (
        <Loading />
      ) : (
        resource.data && (
          <>
            <div className="health-stats">
              {keys.map((key) => (
                <div key={key}>
                  <span>{key.replace(/([A-Z])/g, " $1")}</span>
                  <strong>
                    {Array.isArray(resource.data![key])
                      ? (resource.data![key] as unknown[]).length
                      : typeof resource.data![key] === "number"
                        ? String(resource.data![key])
                        : "—"}
                  </strong>
                </div>
              ))}
            </div>
            {keys.map((key) => (
              <section className="panel health-section" key={key}>
                <div className="panel-head">
                  <h2>{key.replace(/([A-Z])/g, " $1")}</h2>
                </div>
                {Array.isArray(resource.data![key]) &&
                (resource.data![key] as unknown[]).length > 0 ? (
                  (resource.data![key] as Array<Record<string, unknown>>).map(
                    (item, i) => (
                      <div className="health-case" key={String(item.id || i)}>
                        <Status
                          value={
                            item.status ||
                            (item.data as Record<string, unknown> | undefined)
                              ?.status ||
                            "needs_review"
                          }
                        />
                        <div>
                          <strong>
                            {String(
                              item.key ||
                                item.title ||
                                (
                                  item.data as
                                    Record<string, unknown> | undefined
                                )?.key ||
                                item.contentId ||
                                item.id ||
                                "Affected object",
                            )}
                          </strong>
                          <p>
                            {String(
                              item.reason ||
                                item.message ||
                                (
                                  item.data as
                                    Record<string, unknown> | undefined
                                )?.reason ||
                                "Review the current source and dependent content.",
                            )}
                          </p>
                        </div>
                      </div>
                    ),
                  )
                ) : (
                  <p className="panel-note">
                    {locale === "de"
                      ? "Keine gemeldeten Fälle."
                      : "No cases reported."}
                  </p>
                )}
              </section>
            ))}
          </>
        )
      )}
    </>
  );
}
function Inspector() {
  const { project, locale } = useWorkspace();
  const [evidence, setEvidence] = useState<Entity | null>(null);
  const mutation = useMutation();
  return (
    <div className="inspector-layout">
      <section className="panel inspector-form">
        <div className="panel-head">
          <h2>{locale === "de" ? "Retrieval prüfen" : "Inspect retrieval"}</h2>
          <FlaskConical />
        </div>
        <DataForm
          fields={[
            {
              name: "query",
              label: locale === "de" ? "Testfrage" : "Test question",
              type: "textarea",
              required: true,
              max: 2000,
            },
            {
              name: "language",
              label: locale === "de" ? "Sprache" : "Language",
              type: "select",
              value: project.language,
              options: options(["en", "de"]),
            },
            {
              name: "purpose",
              label: locale === "de" ? "Verwendungszweck" : "Purpose",
              type: "select",
              value: "public",
              options: [
                {
                  value: "public",
                  label:
                    locale === "de" ? "Öffentlicher Inhalt" : "Public content",
                },
                {
                  value: "internal",
                  label:
                    locale === "de" ? "Interne Recherche" : "Internal research",
                },
              ],
            },
          ]}
          pending={mutation.pending}
          error={mutation.error}
          submitLabel={locale === "de" ? "Belege abrufen" : "Retrieve evidence"}
          onSubmit={(v) =>
            mutation
              .run(() =>
                action<Entity>(project.id, "retrieve", {
                  query: str(v, "query"),
                  language: str(v, "language"),
                  purpose: str(v, "purpose"),
                }),
              )
              .then((result) => {
                if (result) setEvidence(result);
              })
          }
        />
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>{locale === "de" ? "Evidence-Pack" : "Evidence pack"}</h2>
        </div>
        {evidence ? (
          <div className="evidence-result">
            <div className="detail-summary">
              <Status value={evidence.data.status} />
              <Badge>{value(evidence, "mode")}</Badge>
            </div>
            <dl className="detail-grid">
              <dt>Purpose</dt>
              <dd>{value(evidence, "purpose")}</dd>
              <dt>Retrieval version</dt>
              <dd>{value(evidence, "retrieverVersion")}</dd>
              <dt>Retrieved at</dt>
              <dd>
                {when(evidence.data.createdAt || evidence.createdAt, locale)}
              </dd>
              <dt>Cost / latency</dt>
              <dd>
                {value(evidence, "costMicros", "Not reported")} /{" "}
                {value(evidence, "durationMs", "Not reported")}
              </dd>
            </dl>
            <EvidenceItems evidence={evidence} />
            <details className="evidence-details">
              <summary>Effective filters and excluded results</summary>
              <dl className="detail-grid">
                <dt>Project</dt>
                <dd>{project.name}</dd>
                <dt>Language</dt>
                <dd>{value(evidence, "language")}</dd>
                <dt>Purpose</dt>
                <dd>{value(evidence, "purpose")}</dd>
                <dt>Model processing</dt>
                <dd>
                  {evidence.data.forModel === true
                    ? "Required"
                    : "No model call requested"}
                </dd>
                <dt>Index profile</dt>
                <dd>{value(evidence, "indexProfile")}</dd>
                <dt>Estimated tokens</dt>
                <dd>{value(evidence, "estimatedTokens")}</dd>
              </dl>
              {Array.isArray(evidence.data.excluded) &&
              evidence.data.excluded.length > 0 ? (
                evidence.data.excluded.map((x, i) => (
                  <div className="history-row" key={i}>
                    <span>
                      {String(
                        (x as Record<string, unknown>).sourceId || "Source",
                      )}
                    </span>
                    <span>
                      {String(
                        (x as Record<string, unknown>).reason || "Excluded",
                      )}
                    </span>
                  </div>
                ))
              ) : (
                <p>No excluded sources were reported.</p>
              )}
            </details>
          </div>
        ) : (
          <Empty
            icon={Search}
            title={
              locale === "de"
                ? "Jede Antwort beginnt mit Belegen"
                : "Every answer starts with evidence"
            }
            description={
              locale === "de"
                ? "Prüfe Fakten, Quellenpassagen und Wissenslücken in deinem Rechtekontext."
                : "Inspect facts, source passages and gaps within your permissions."
            }
          />
        )}
      </section>
    </div>
  );
}
