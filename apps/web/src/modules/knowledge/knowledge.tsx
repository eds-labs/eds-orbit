"use client";
import { contentLanguageOptions } from "@/platform/project-settings/project-configuration";
import {
  IndexStateBadge,
  SourceIndexPanel,
  useIndexStatus,
} from "./index-status";
import { KnowledgeWorkspaceGate } from "./workspace";
import { FactWithdrawal } from "./fact-withdrawal";
import { IndexManagement } from "./index-management";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { useShell } from "@/platform/shell/shell-context";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
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
} from "@/components/ui/primitives";
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
} from "@/platform/ui/form";
import { useWorkspace } from "@/components/workspace-context";
import {
  EntityRows,
  PageHead,
  ResourceError,
  useCollection,
} from "@/platform/ui/collection";
import { EvidenceItems } from "@/platform/ui/evidence";
import { AppLink } from "@/platform/ui/app-link";
import { KnowledgeOverview } from "./overview";
import { expertCopy, expertFill, expertValue } from "./expert-text";
type Health = Record<string, unknown>;
/** The knowledge tabs in their order; each has its own URL (WP3.3). */
export const KNOWLEDGE_TABS = [
  "review",
  "overview",
  "sources",
  "facts",
  "import",
  "conflicts",
  "library",
  "health",
  "inspector",
  "impact",
  "github",
] as const;
export type KnowledgeTab = (typeof KNOWLEDGE_TABS)[number];
/**
 * A knowledge page. The overview is the module's root; every other tab is a
 * page of its own, reached from the sidebar, with a link back to the overview.
 */
export function Knowledge({ tab }: { tab: KnowledgeTab }) {
  return (
    <KnowledgeWorkspaceGate
      tab={tab}
      fallback={
        <LegacyKnowledge
          tab={
            tab === "review"
              ? "conflicts"
              : tab === "github"
                ? "overview" // GitHub setup exists only in the workspace.
                : tab
          }
        />
      }
    />
  );
}
function LegacyKnowledge({ tab }: { tab: KnowledgeTab }) {
  const { t, locale, isOwner } = useWorkspace();
  const x = expertCopy[locale];
  const shell = useShell();
  const [add, setAdd] = useState(false);
  if (tab === "overview") return <KnowledgeOverview />;
  return (
    <>
      <AppLink
        className="text-link knowledge-back"
        href={shell.hrefOf("knowledge")}
      >
        <ArrowLeft aria-hidden />
        {t("knowledge")}
      </AppLink>
      <PageHead title={t("knowledge")} description={t("knowledgeHint")}>
        {isOwner && (tab === "sources" || tab === "facts") && (
          <Button onClick={() => setAdd(true)}>
            <Plus data-icon="inline-start" />
            {tab === "facts" ? t("addFact") : t("addSource")}
          </Button>
        )}
      </PageHead>
      {tab === "sources" ? (
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
              <strong>{x.principleFacts}</strong>
              <p>{x.principleFactsHint}</p>
            </div>
          </div>
          <div>
            <BookOpen />
            <div>
              <strong>{x.principleLibrary}</strong>
              <p>{x.principleLibraryHint}</p>
            </div>
          </div>
          <div>
            <ShieldCheck />
            <div>
              <strong>{x.principleMemory}</strong>
              <p>{x.principleMemoryHint}</p>
            </div>
          </div>
        </div>
      )}
      <Alert>{x.separated}</Alert>
      {add &&
        (tab === "sources" ? (
          <SourceEditor onClose={() => setAdd(false)} />
        ) : (
          <FactEditor onClose={() => setAdd(false)} />
        ))}
    </>
  );
}
/**
 * Who may retrieve a source (WP3.5). Each option is a comma-separated list
 * of module ids; a source without audiences is open to all modules.
 */
function audienceOptions(de: boolean) {
  const x = expertCopy[de ? "de" : "en"];
  return [
    { value: "all", label: x.audAll },
    { value: "marketing", label: x.audMarketing },
    { value: "support", label: x.audSupport },
    { value: "marketing,support", label: x.audBoth },
  ];
}
function audienceValue(audiences: unknown) {
  return Array.isArray(audiences) &&
    audiences.length &&
    !audiences.includes("all")
    ? [...audiences].map(String).sort().join(",")
    : "all";
}
function audienceLabel(audiences: unknown, de: boolean) {
  const current = audienceValue(audiences);
  return (
    audienceOptions(de).find((o) => o.value === current)?.label ??
    current.split(",").join(", ")
  );
}
function Sources() {
  const { t, locale, project, canEdit, isOwner, refresh, revision } =
    useWorkspace();
  const resource = useCollection("sources");
  const index = useIndexStatus(project.id, revision);
  const [search, setSearch] = useState(""),
    [selected, setSelected] = useState<Entity | null>(null),
    [create, setCreate] = useState(false),
    [importing, setImporting] = useState(false),
    [revoke, setRevoke] = useState(false),
    [audiences, setAudiences] = useState(false);
  const mutation = useMutation(() => {
    refresh();
    resource.refresh();
  });
  const de = locale === "de";
  const x = expertCopy[locale];
  // A link can name the source to open, such as a warning's "Read in content".
  const named = useSearchParams()?.get("source");
  const current =
    resource.data?.items.find((e) => e.id === (selected?.id ?? named)) ||
    selected;
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
                      {expertValue(e.data.type, locale)} ·{" "}
                      {e.data.publicUse ? x.public : x.internal}
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
                  <Status
                    value={e.data.status}
                    label={expertValue(e.data.status, locale)}
                  />
                  <IndexStateBadge
                    status={index.byId.get(e.id)}
                    locale={locale}
                  />
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
              ? `${expertValue(current.data.type, locale)} · ${expertValue(current.data.authority, locale)} · v${current.version}`
              : t("sourceSelect")}
          </p>
          {current && (
            <>
              <Status
                value={current.data.status}
                label={expertValue(current.data.status, locale)}
              />
              <div className="rights-flags">
                <Badge tone={current.data.publicUse ? "success" : "neutral"}>
                  {current.data.publicUse ? x.publicUse : x.internalOnly}
                </Badge>
                <Badge tone={current.data.modelUse ? "blue" : "warning"}>
                  {current.data.modelUse ? x.modelAllowed : x.modelNo}
                </Badge>
                <Badge
                  tone={
                    audienceValue(current.data.audiences) === "all"
                      ? "neutral"
                      : "warning"
                  }
                >
                  {audienceLabel(current.data.audiences, de)}
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
            <SourceIndexPanel
              projectId={project.id}
              source={current}
              status={index.byId.get(current.id)}
              isOwner={isOwner}
              locale={locale}
              timezone={project.timezone}
              onChanged={() => {
                refresh();
                resource.refresh();
                index.refresh();
              }}
            />
          )}
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
                      ? x.resumeSource
                      : x.pauseSource}
                  </Button>
                  <Button variant="outline" onClick={() => setAudiences(true)}>
                    <ShieldCheck data-icon="inline-start" />
                    {x.changeAudience}
                  </Button>
                  <Button variant="destructive" onClick={() => setRevoke(true)}>
                    <Trash2 data-icon="inline-start" />
                    {x.revokeAccess}
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
      {audiences && current && (
        <Modal
          title={x.audienceTitle}
          description={x.audienceHint}
          onClose={() => setAudiences(false)}
        >
          <DataForm
            fields={[
              {
                name: "audience",
                label: x.audience,
                type: "select",
                value: audienceValue(current.data.audiences),
                options: audienceOptions(de),
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel={x.saveAudience}
            onCancel={() => setAudiences(false)}
            onSubmit={(v) =>
              mutation
                .run(() =>
                  action(project.id, "source-audiences", {
                    sourceId: current.id,
                    audiences: str(v, "audience").split(","),
                  }),
                )
                .then((result) => {
                  if (result) setAudiences(false);
                })
            }
          />
        </Modal>
      )}
      {revoke && current && (
        <Modal
          title={x.revokeTitle}
          description={x.revokeHint}
          onClose={() => setRevoke(false)}
        >
          <p>
            <strong>{value(current, "name")}</strong> · v{current.version}
          </p>
          <DataForm
            fields={[
              {
                name: "confirm",
                label: x.revokeConfirm,
                type: "checkbox",
                required: true,
              },
            ]}
            pending={mutation.pending}
            error={mutation.error}
            submitLabel={x.revokeNow}
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
  const x = expertCopy[locale];
  const labelled = (values: string[]) =>
    values.map((value) => ({ value, label: expertValue(value, locale) }));
  const fields: FormField[] = [
    { name: "name", label: t("name"), required: true },
    {
      name: "type",
      label: x.sourceType,
      type: "select",
      value: "manual",
      options: labelled(["manual", "file", "website", "gitbook"]),
    },
    {
      name: "authority",
      label: x.authority,
      type: "select",
      value: "research",
      options: labelled(["official", "website", "research", "generated"]),
      hint: x.authorityHint,
    },
    {
      name: "allowedOrigins",
      label: x.origins,
      placeholder: "https://example.com",
      hint: x.originsHint,
    },
    {
      name: "allowedPaths",
      label: x.paths,
      value: "/",
    },
    {
      name: "maxAgeHours",
      label: x.freshness,
      type: "number",
      required: true,
      min: 1,
      max: 8760,
      value: 168,
    },
    {
      name: "syncEveryHours",
      label: x.syncEvery,
      type: "number",
      min: 1,
      max: 168,
      showWhen: { name: "type", values: ["website", "gitbook"] },
      hint: x.syncHint,
    },
    { name: "publicUse", label: t("publicUse"), type: "checkbox" },
    { name: "modelUse", label: t("modelUse"), type: "checkbox" },
    {
      name: "audience",
      label: x.audience,
      type: "select",
      value: "all",
      options: audienceOptions(de),
      hint: x.audienceFieldHint,
    },
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
                // "all" sends nothing: the default shape of existing sources.
                ...(str(v, "audience") && str(v, "audience") !== "all"
                  ? { audiences: str(v, "audience").split(",") }
                  : {}),
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
  const x = expertCopy[locale];
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
      description={x.importDescription}
      onClose={onClose}
    >
      {!url && (
        <div className="file-upload">
          <label htmlFor="source-file">{x.importFile}</label>
          <Input
            id="source-file"
            type="file"
            accept=".txt,.md,.html,.pdf,.docx"
            onChange={(e) => {
              const next = e.target.files?.[0] || null;
              if (next && next.size > 1_000_000) {
                setFileError(x.uploadTooBig);
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
                  label: x.sourceUrl,
                  type: "url",
                  required: true,
                },
              ]
            : [
                {
                  name: "externalId",
                  label: x.documentId,
                  required: true,
                  value: file?.name,
                  hint: x.documentIdHint,
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
                        label: x.documentText,
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
                  options: contentLanguageOptions(project, locale),
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
              if (!mimeType) throw new Error(x.unsupportedType);
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
  const x = expertCopy[locale];
  const history = useCollection("knowledge_imports");
  const [payload, setPayload] = useState(
    JSON.stringify(
      {
        name: "Product documentation",
        sourceType: "url_list",
        authority: "website",
        publicUse: false,
        modelUse: false,
        allowedOrigins: [],
        allowedPaths: ["/"],
        maxAgeHours: 168,
        documents: [
          {
            externalId: "page-1",
            title: "Page title",
            text: "Paste Markdown, TXT, HTML, or extracted file text here.",
            mimeType: "text/markdown",
            language: "en",
            selected: true,
          },
        ],
        facts: [],
      },
      null,
      2,
    ),
  );
  const [preview, setPreview] = useState<Record<string, any> | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const mutation = useMutation(() => refresh());
  const download = (name: string, content: string) => {
    const a = document.createElement("a");
    a.href = `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`;
    a.download = name;
    a.click();
  };
  const parsed = () => JSON.parse(payload);
  const importFactsFile = async (file: File | null) => {
    if (!file) return;
    if (file.size > 1_000_000) {
      setFileError(x.importTooBig);
      return;
    }
    try {
      const raw = await file.text();
      const rows: Record<string, unknown>[] = file.name
        .toLowerCase()
        .endsWith(".json")
        ? (() => {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : parsed.facts;
          })()
        : parseFactCsv(raw, x);
      if (!Array.isArray(rows) || !rows.length) throw new Error(x.noFactRows);
      const facts = rows.map((row) => ({
        key: String(row.key ?? ""),
        value: String(row.value ?? ""),
        valueType: String(row.valueType ?? "text"),
        language: String(row.language ?? project.language),
        validFrom: String(row.validFrom ?? new Date().toISOString()),
        ...(row.validUntil ? { validUntil: String(row.validUntil) } : {}),
        ...(row.currency ? { currency: String(row.currency) } : {}),
        ...(row.unit ? { unit: String(row.unit) } : {}),
        ...(row.market ? { market: String(row.market) } : {}),
        publicUse: row.publicUse === true || row.publicUse === "true",
        modelUse: row.modelUse === true || row.modelUse === "true",
      }));
      setPayload(
        JSON.stringify(
          {
            name: file.name.replace(/\.(csv|json)$/i, ""),
            sourceType: "verified_facts",
            authority: "official",
            publicUse: facts.some((row) => row.publicUse),
            modelUse: facts.some((row) => row.modelUse),
            documents: [],
            facts,
          },
          null,
          2,
        ),
      );
      setPreview(null);
      setFileError(null);
    } catch (error) {
      setFileError(error instanceof Error ? error.message : x.fileUnreadable);
    }
  };
  return (
    <section className="panel stack-gap">
      <div className="panel-head">
        <div>
          <h2>{x.importTitle}</h2>
          <p>{x.importIntro}</p>
        </div>
      </div>
      <div className="form-actions">
        <Button
          variant="outline"
          onClick={() =>
            download(
              "orbit-verified-facts.csv",
              "key,value,valueType,language,validFrom,publicUse,modelUse\nproduct.status,active,status,en,2026-01-01T00:00:00.000Z,false,false\n",
            )
          }
        >
          <Download data-icon="inline-start" />
          {x.csvTemplate}
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            download(
              "orbit-verified-facts.json",
              JSON.stringify(
                {
                  facts: [
                    {
                      key: "product.status",
                      value: "active",
                      valueType: "status",
                      language: "en",
                      validFrom: "2026-01-01T00:00:00.000Z",
                      publicUse: false,
                      modelUse: false,
                    },
                  ],
                },
                null,
                2,
              ),
            )
          }
        >
          <Download data-icon="inline-start" />
          {x.jsonTemplate}
        </Button>
      </div>
      <div className="file-upload">
        <label htmlFor="verified-facts-file">{x.uploadFacts}</label>
        <Input
          id="verified-facts-file"
          type="file"
          accept=".csv,application/json,.json,text/csv"
          onChange={(event) => importFactsFile(event.target.files?.[0] ?? null)}
        />
        <p>{x.uploadFactsHint}</p>
      </div>
      {fileError && <Alert kind="error">{fileError}</Alert>}
      <label htmlFor="knowledge-import-payload">{x.payloadLabel}</label>
      <textarea
        id="knowledge-import-payload"
        className="input min-h-80 font-mono text-xs"
        value={payload}
        onChange={(event) => {
          setPayload(event.target.value);
          setPreview(null);
        }}
        aria-describedby="knowledge-import-help"
      />
      <p id="knowledge-import-help">{x.payloadHelp}</p>
      {preview && (
        <Alert kind={preview.ready ? "success" : "warning"}>
          {preview.ready
            ? expertFill(x.previewReady, {
                documents: preview.documents?.length ?? 0,
                facts: preview.factCount ?? 0,
              })
            : expertFill(x.previewResolve, {
                codes: (preview.errors ?? [])
                  .map((error: any) => error.code)
                  .join(", "),
              })}
        </Alert>
      )}
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      <div className="form-actions">
        <Button
          variant="outline"
          disabled={mutation.pending}
          onClick={() =>
            mutation
              .run(() =>
                action(project.id, "knowledge-import-preview", parsed()),
              )
              .then((value) => {
                if (value) setPreview(value as Record<string, any>);
              })
          }
        >
          {x.previewImport}
        </Button>
        <Button
          disabled={!isOwner || !preview?.ready || mutation.pending}
          onClick={() =>
            mutation
              .run(() =>
                action(project.id, "knowledge-import-commit", parsed()),
              )
              .then(() => setPreview(null))
          }
        >
          {x.commitImport}
        </Button>
      </div>
      <h3>{x.importHistory}</h3>
      {history.data?.items.length ? (
        <ExpertRows
          items={history.data.items}
          fields={[
            "name",
            "sourceType",
            "status",
            "completed",
            "failed",
            "completedAt",
          ]}
        />
      ) : (
        <p>{x.noImports}</p>
      )}
    </section>
  );
}
/** A table of expert records with named columns and labelled values. */
function ExpertRows({
  items,
  fields,
  onSelect,
}: {
  items: Entity[];
  fields: string[];
  onSelect?: (e: Entity) => void;
}) {
  const { locale, project } = useWorkspace();
  const x = expertCopy[locale];
  const heads: Record<string, string> = {
    key: x.colKey,
    value: x.colValue,
    status: x.colStatus,
    updatedAt: x.colUpdatedAt,
    title: x.colTitle,
    language: x.colLanguage,
    name: x.colName,
    sourceType: x.colSourceType,
    completed: x.colCompleted,
    failed: x.colFailed,
    completedAt: x.colCompletedAt,
  };
  const cell = (e: Entity, f: string) =>
    f === "status" ? (
      <Status
        value={e.data.status}
        label={expertValue(e.data.status, locale)}
      />
    ) : f === "updatedAt" ? (
      when(e.updatedAt, locale, project.timezone)
    ) : f === "completedAt" ? (
      when(e.data.completedAt, locale, project.timezone)
    ) : f === "sourceType" ? (
      expertValue(e.data.sourceType, locale)
    ) : (
      value(e, f)
    );
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {fields.map((f) => (
              <th key={f}>{heads[f] ?? x.unknown}</th>
            ))}
            {onSelect && (
              <th>
                <span className="sr-only">{x.review}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.id}>
              {fields.map((f, i) => (
                <td key={f}>
                  {i === 0 && onSelect ? (
                    <button className="row-button" onClick={() => onSelect(e)}>
                      {value(e, f)}
                    </button>
                  ) : (
                    cell(e, f)
                  )}
                </td>
              ))}
              {onSelect && (
                <td>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${x.review} ${value(e, fields[0]!)}`}
                    onClick={() => onSelect(e)}
                  >
                    <ArrowRight />
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function parseFactCsv(
  raw: string,
  x: (typeof expertCopy)["de"],
): Record<string, string>[] {
  const lines = raw.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error(x.csvNeedsRows);
  const cells = (line: string) => {
    const values: string[] = [];
    let value = "",
      quoted = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i]!;
      if (char === '"' && line[i + 1] === '"') {
        value += char;
        i++;
      } else if (char === '"') quoted = !quoted;
      else if (char === "," && !quoted) {
        values.push(value.trim());
        value = "";
      } else value += char;
    }
    if (quoted) throw new Error(x.csvMalformed);
    values.push(value.trim());
    return values;
  };
  const header = cells(lines[0]!);
  if (!header.includes("key") || !header.includes("value"))
    throw new Error(x.csvColumns);
  return lines
    .slice(1)
    .filter(Boolean)
    .map((line) =>
      Object.fromEntries(
        cells(line).map((value, index) => [header[index] ?? "", value]),
      ),
    );
}
function Facts() {
  const { t, locale, project, isOwner } = useWorkspace();
  const x = expertCopy[locale];
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
            aria-label={x.searchFacts}
            placeholder={x.searchFacts}
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
            <ExpertRows
              items={items}
              fields={["key", "value", "status", "updatedAt"]}
              onSelect={setSelected}
            />
          ) : (
            <Empty
              icon={ShieldCheck}
              title={x.factsEmptyTitle}
              description={x.factsEmptyHint}
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
            <Status
              value={selected.data.status}
              label={expertValue(selected.data.status, locale)}
            />
            <Badge>
              {x.version} {selected.version}
            </Badge>
          </div>
          <h2 className="fact-value">
            {value(selected, "value")} {value(selected, "currency", "")}{" "}
            {value(selected, "unit", "")}
          </h2>
          <dl className="detail-grid">
            <dt>{x.detailSource}</dt>
            <dd>{value(selected, "sourceId")}</dd>
            <dt>{x.validFrom}</dt>
            <dd>{when(selected.data.validFrom, locale, project.timezone)}</dd>
            <dt>{x.validUntil}</dt>
            <dd>{when(selected.data.validUntil, locale, project.timezone)}</dd>
            <dt>{x.verifiedAt}</dt>
            <dd>{when(selected.data.verifiedAt, locale, project.timezone)}</dd>
            <dt>{x.verifiedBy}</dt>
            <dd>{value(selected, "verifiedBy")}</dd>
            <dt>{x.languageMarket}</dt>
            <dd>
              {value(selected, "language")} / {value(selected, "market")}
            </dd>
            <dt>{x.publicUse}</dt>
            <dd>{selected.data.publicUse ? x.allowed : x.notPermitted}</dd>
            <dt>{x.modelProcessing}</dt>
            <dd>{selected.data.modelUse ? x.allowed : x.notPermitted}</dd>
          </dl>
          <FactWithdrawal entity={selected} onDone={() => setSelected(null)} />
          {isOwner && (
            <div className="form-actions">
              <Button onClick={() => setEditing(true)}>
                {x.correctVersion}
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
  const x = expertCopy[locale];
  const labelled = (values: string[]) =>
    values.map((value) => ({ value, label: expertValue(value, locale) }));
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
      label: x.factKey,
      required: true,
      value: d?.key as string,
      placeholder: "product.availability",
    },
    {
      name: "value",
      label: x.factValue,
      required: true,
      value: d?.value as string,
    },
    {
      name: "valueType",
      label: x.valueType,
      type: "select",
      value: String(d?.valueType || "text"),
      options: labelled(["text", "decimal", "date", "status", "url"]),
    },
    {
      name: "currency",
      label: x.currency,
      value: d?.currency as string,
      placeholder: "EUR",
    },
    { name: "unit", label: x.unit, value: d?.unit as string },
    {
      name: "language",
      label: t("language"),
      type: "select",
      value: String(d?.language || project.language),
      options: contentLanguageOptions(
        project,
        locale,
        d?.language ? String(d.language) : undefined,
      ),
    },
    {
      name: "market",
      label: x.market,
      value: d?.market as string,
    },
    {
      name: "sourceId",
      label: x.supportingSource,
      type: "select",
      required: true,
      value: d?.sourceId as string,
      options: (sources.data?.items || [])
        .filter((s) => s.data.status === "active")
        .map((s) => ({ value: s.id, label: value(s, "name") })),
    },
    {
      ...dateField("validFrom", x.validFromBrowser),
      value: browserDate(d?.validFrom),
    },
    {
      ...dateField("validUntil", x.validUntilOptional, false),
      value: browserDate(d?.validUntil),
    },
    {
      name: "status",
      label: x.reviewStatus,
      type: "select",
      value: resolving ? "verified" : "candidate",
      options: labelled(
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
      label: x.resolveConfirm,
    });
  return (
    <Modal title={entity ? x.correctFact : t("addFact")} onClose={onClose}>
      {resolving && (
        <>
          <Alert kind="warning">{x.resolveHint}</Alert>
          <ul className="blocker-list">
            {conflicts.map((fact) => (
              <li key={fact.id}>
                {value(fact, "value")} {value(fact, "currency", "")} ·{" "}
                {x.conflictVersion} {fact.version} ·{" "}
                {expertValue(fact.data.status, locale)}
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
  const sourceFilter = useSearchParams()?.get("source");
  const { project, revision, t, locale, isOwner, refresh } = useWorkspace();
  const x = expertCopy[locale];
  const resource = useResource<{ items: Array<Record<string, unknown>> }>(
    collectionPath(project.id, `documents?revision=${revision}`),
  );
  const sources = useCollection("sources");
  const documents = (resource.data?.items || [])
    .filter((raw) => !sourceFilter || raw.sourceId === sourceFilter)
    .map((raw) => {
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
  const [confirmEmbedding, setConfirmEmbedding] = useState(false);
  const mutation = useMutation(() => {
    refresh();
    resource.refresh();
    setConfirmEmbedding(false);
  });
  return (
    <>
      <ResourceError error={resource.error} retry={resource.refresh} />
      {resource.loading ? (
        <Loading />
      ) : (
        <section className="panel">
          {documents.length ? (
            <ExpertRows
              items={documents}
              fields={["title", "language", "status", "updatedAt"]}
              onSelect={setSelected}
            />
          ) : (
            <Empty
              icon={BookOpen}
              title={x.libraryEmptyTitle}
              description={x.libraryEmptyHint}
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
            <Status
              value={selected.data.status}
              label={expertValue(selected.data.status, locale)}
            />
            <Badge>{selected.data.publicUse ? x.public : x.internal}</Badge>
            <span>
              {x.version} {selected.version}
            </span>
          </div>
          <p>{value(selected, "canonicalUrl", "")}</p>
          {isOwner && (
            <>
              {!confirmEmbedding ? (
                <div className="form-actions">
                  <Button
                    variant="outline"
                    onClick={() => setConfirmEmbedding(true)}
                  >
                    {x.embedWithOpenAI}
                  </Button>
                </div>
              ) : (
                <>
                  <Alert kind="warning">{x.embedWarning}</Alert>
                  <DataForm
                    fields={[
                      {
                        name: "confirmEmbeddingMayBeSentToOpenAI",
                        type: "checkbox",
                        required: true,
                        label: x.embedConfirm,
                      },
                    ]}
                    pending={mutation.pending}
                    error={mutation.error}
                    submitLabel={x.embedQueue}
                    onCancel={() => setConfirmEmbedding(false)}
                    onSubmit={() =>
                      mutation
                        .run(() =>
                          action(project.id, "embed-document", {
                            documentId: selected.id,
                            confirmEmbeddingMayBeSentToOpenAI: true,
                          }),
                        )
                        .then(() => {})
                    }
                  />
                </>
              )}
            </>
          )}
          <article className="content-preview">
            {value(selected, "text", value(selected, "preview", ""))}
          </article>
          <h3>{x.versionHistory}</h3>
          {Array.isArray(selected.data.versions) ? (
            selected.data.versions.map((v, i) => (
              <div className="history-row" key={i}>
                {Object.entries(v as Record<string, unknown>)
                  .filter(([key]) =>
                    ["version", "createdAt", "contentHash", "status"].includes(
                      key,
                    ),
                  )
                  .map(([key, entry]) => (
                    <span key={key}>
                      {{
                        version: x.histVersion,
                        createdAt: x.histCreatedAt,
                        contentHash: x.histContentHash,
                        status: x.histStatus,
                      }[key] ?? x.unknown}
                      :{" "}
                      {key === "status"
                        ? expertValue(entry, locale)
                        : String(entry)}
                    </span>
                  ))}
              </div>
            ))
          ) : (
            <p>{x.noOlderVersions}</p>
          )}
          <h3>{x.extractedPassages}</h3>
          {Array.isArray(selected.data.chunks) ? (
            selected.data.chunks.map((c, i) => (
              <div className="chunk" key={i}>
                <small>
                  {String(
                    (c as Record<string, unknown>).anchor ||
                      `${x.passage} ${i + 1}`,
                  )}
                </small>
                <p>{String((c as Record<string, unknown>).text || "")}</p>
              </div>
            ))
          ) : (
            <p>{x.noPassages}</p>
          )}
        </Modal>
      )}
    </>
  );
}
function KnowledgeHealth({ impact = false }: { impact?: boolean }) {
  const { project, revision, locale, isOwner } = useWorkspace();
  const x = expertCopy[locale];
  const resource = useResource<Health>(
    collectionPath(project.id, `knowledge-health?revision=${revision}`),
  );
  const keys = impact
    ? ["impacts"]
    : ["conflicts", "expiredFacts", "failedImports", "staleSources"];
  const names: Record<string, string> = {
    conflicts: x.conflicts,
    expiredFacts: x.expiredFacts,
    failedImports: x.failedImports,
    staleSources: x.staleSources,
    impacts: x.impacts,
  };
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
                  <span>{names[key]}</span>
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
                  <h2>{names[key]}</h2>
                </div>
                {Array.isArray(resource.data![key]) &&
                (resource.data![key] as unknown[]).length > 0 ? (
                  (resource.data![key] as Array<Record<string, unknown>>).map(
                    (item, i) => {
                      const data = item.data as
                        Record<string, unknown> | undefined;
                      const name =
                        item.key ??
                        item.title ??
                        data?.key ??
                        item.name ??
                        data?.name;
                      const named =
                        name !== undefined && name !== null && name !== "";
                      const id = item.contentId ?? item.id;
                      return (
                        <div className="health-case" key={String(item.id || i)}>
                          {(() => {
                            const status =
                              item.status || data?.status || "needs_review";
                            return (
                              <Status
                                value={status}
                                label={expertValue(status, locale)}
                              />
                            );
                          })()}
                          <div>
                            <strong>
                              {named ? String(name) : x.affectedObject}
                            </strong>
                            {!named && id !== undefined && id !== null && (
                              <small>{String(id)}</small>
                            )}
                            <p>
                              {String(
                                item.reason ||
                                  item.message ||
                                  data?.reason ||
                                  x.reviewSource,
                              )}
                            </p>
                          </div>
                        </div>
                      );
                    },
                  )
                ) : (
                  <p className="panel-note">{x.noCases}</p>
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
  const x = expertCopy[locale];
  const [evidence, setEvidence] = useState<Entity | null>(null);
  const mutation = useMutation();
  return (
    <div className="inspector-layout">
      <section className="panel inspector-form">
        <div className="panel-head">
          <h2>{x.inspectTitle}</h2>
          <FlaskConical />
        </div>
        <DataForm
          fields={[
            {
              name: "query",
              label: x.testQuestion,
              type: "textarea",
              required: true,
              max: 2000,
            },
            {
              name: "language",
              label: x.language,
              type: "select",
              value: project.language,
              options: contentLanguageOptions(project, locale),
            },
            {
              name: "purpose",
              label: x.purpose,
              type: "select",
              value: "public",
              options: [
                { value: "public", label: x.purposePublic },
                { value: "internal", label: x.purposeInternal },
              ],
            },
          ]}
          pending={mutation.pending}
          error={mutation.error}
          submitLabel={x.retrieveEvidence}
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
          <h2>{x.evidencePack}</h2>
        </div>
        {evidence ? (
          <div className="evidence-result">
            <div className="detail-summary">
              <Status
                value={evidence.data.status}
                label={expertValue(evidence.data.status, locale)}
              />
              <Badge>{expertValue(evidence.data.mode, locale)}</Badge>
            </div>
            <dl className="detail-grid">
              <dt>{x.purpose}</dt>
              <dd>{expertValue(evidence.data.purpose, locale)}</dd>
              <dt>{x.retrievalVersion}</dt>
              <dd>{value(evidence, "retrieverVersion")}</dd>
              <dt>{x.retrievedAt}</dt>
              <dd>
                {when(evidence.data.createdAt || evidence.createdAt, locale)}
              </dd>
              <dt>{x.costLatency}</dt>
              <dd>
                {value(evidence, "costMicros", x.notReported)} /{" "}
                {value(evidence, "durationMs", x.notReported)}
              </dd>
            </dl>
            <EvidenceItems evidence={evidence} />
            <details className="evidence-details">
              <summary>{x.filtersSummary}</summary>
              <dl className="detail-grid">
                <dt>{x.project}</dt>
                <dd>{project.name}</dd>
                <dt>{x.language}</dt>
                <dd>{value(evidence, "language")}</dd>
                <dt>{x.purpose}</dt>
                <dd>{expertValue(evidence.data.purpose, locale)}</dd>
                <dt>{x.modelProcessing}</dt>
                <dd>
                  {evidence.data.forModel === true ? x.required : x.noModelCall}
                </dd>
                <dt>{x.indexProfile}</dt>
                <dd>{value(evidence, "indexProfile")}</dd>
                <dt>{x.estimatedTokens}</dt>
                <dd>{value(evidence, "estimatedTokens")}</dd>
              </dl>
              {Array.isArray(evidence.data.excluded) &&
              evidence.data.excluded.length > 0 ? (
                evidence.data.excluded.map((excluded, i) => (
                  <div className="history-row" key={i}>
                    <span>
                      {String(
                        (excluded as Record<string, unknown>).sourceId ||
                          x.excludedSource,
                      )}
                    </span>
                    <span>
                      {String(
                        (excluded as Record<string, unknown>).reason ||
                          x.excluded,
                      )}
                    </span>
                  </div>
                ))
              ) : (
                <p>{x.noneExcluded}</p>
              )}
            </details>
          </div>
        ) : (
          <Empty
            icon={Search}
            title={x.inspectEmptyTitle}
            description={x.inspectEmptyHint}
          />
        )}
      </section>
    </div>
  );
}
