"use client";
import { useSearchParams } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import { Plus, RefreshCw, ExternalLink, CheckCircle2 } from "lucide-react";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import {
  api,
  action,
  useResource,
  useMutation,
  when,
  type Entity,
} from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Input,
  Textarea,
  Loading,
  Empty,
} from "@/components/ui/primitives";
import type { KnowledgeDraft } from "../../../../../packages/schemas/src/knowledge-workspace";
import {
  knowledgeCopy,
  workspaceStatus,
  type KnowledgeCopy,
} from "./workspace-text";
import type { KnowledgeTab } from "./knowledge";

type Summary = {
  enabled: boolean;
  profile: Record<string, any>;
  drafts: Entity[];
  runs: Entity[];
  proposals: Entity[];
  facts: Entity[];
  sources: Entity[];
};
type Preview = {
  id: string;
  commit: string | null;
  partial: boolean;
  skipped: number;
  files: { path: string; characters: number }[];
  characters: number;
  modelRequired: boolean;
};
type Github = {
  configured: boolean;
  installUrl: string | null;
  connections: { id: string; account: string }[];
};
type Repo = {
  id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
};
const topics = [
  "description",
  "audience",
  "platforms",
  "features",
  "limitations",
] as const;
const textOf = (p: Entity) => String(p.data.statement ?? p.data.value ?? "");
const inputClass = "input";
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="knowledge-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function KnowledgeWorkspaceGate({
  tab,
  fallback,
}: {
  tab: KnowledgeTab;
  fallback: ReactNode;
}) {
  const { project, revision, locale } = useWorkspace();
  const expert = useSearchParams()?.get("expert") === "1";
  const resource = useResource<Summary>(
    `/projects/${project.id}/knowledge-workspace?revision=${revision}`,
  );
  const retained = useRef<{ projectId: string; data: Summary } | null>(null);
  if (resource.data)
    retained.current = { projectId: project.id, data: resource.data };
  const data =
    resource.data ??
    (retained.current?.projectId === project.id ? retained.current.data : null);
  useEffect(() => {
    if (
      !data?.runs?.some((r) =>
        ["queued", "analyzing"].includes(String(r.data.status)),
      )
    )
      return;
    const timer = setInterval(resource.refresh, 4000);
    return () => clearInterval(timer);
  }, [data, resource.refresh]);
  if (
    data?.enabled &&
    (expert || ["library", "health", "inspector", "impact"].includes(tab))
  )
    return fallback;
  if (data?.enabled)
    return (
      <WorkspaceView
        key={`${project.id}:${tab}`}
        data={data}
        tab={tab}
        refresh={resource.refresh}
      />
    );
  if (resource.loading && !data) return <Loading label="…" />;
  if (resource.error && resource.error.status !== 404)
    return (
      <section className="stack-gap">
        <Alert kind="error">{knowledgeCopy[locale].unavailable}</Alert>
        <Button variant="outline" onClick={resource.refresh}>
          {knowledgeCopy[locale].retry}
        </Button>
      </section>
    );
  return fallback;
}

function WorkspaceView({
  data,
  tab,
  refresh,
}: {
  data: Summary;
  tab: KnowledgeTab;
  refresh: () => void;
}) {
  const { locale, project, isOwner } = useWorkspace();
  const shell = useShell();
  const t = knowledgeCopy[locale];
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState("");
  const review = tab === "review" || tab === "conflicts";
  const proposals = data.proposals.filter((p) =>
    review
      ? ["pending", "needs_review"].includes(String(p.data.status))
      : p.data.status === "accepted",
  );
  const filtered = proposals.filter(
    (p) =>
      (!topic || p.data.topic === topic) &&
      textOf(p).toLowerCase().includes(query.toLowerCase()),
  );
  const oldFacts = data.facts.filter(
    (f) =>
      f.data.status === "verified" &&
      !String(f.data.key).startsWith("knowledge.") &&
      String(f.data.value).toLowerCase().includes(query.toLowerCase()),
  );
  const shownOldFacts = !review && !topic ? oldFacts : [];
  if (tab === "import")
    return <KnowledgeWizard data={data} refresh={refresh} />;
  if (["library", "health", "inspector", "impact"].includes(tab))
    return <LegacyExpert tab={tab} />;
  return (
    <div className="knowledge-workspace stack-gap">
      <header className="knowledge-heading">
        <div>
          <h1>{tab === "sources" ? t.sources : review ? t.review : t.title}</h1>
          <p>{t.hint}</p>
        </div>
        {isOwner && (
          <Button asChild>
            <AppLink href={shell.hrefOf("knowledge-import")}>
              <Plus aria-hidden="true" />
              {t.add}
            </AppLink>
          </Button>
        )}
      </header>
      {tab === "sources" ? (
        <SourceList data={data} refresh={refresh} t={t} />
      ) : (
        <>
          {!review && (data.profile.description || data.profile.audience) && (
            <section className="knowledge-profile" aria-label={t.title}>
              <h2>{project.name}</h2>
              {data.profile.description && (
                <p>{String(data.profile.description)}</p>
              )}
              {data.profile.audience && (
                <p>
                  <strong>{t.audience}: </strong>
                  {String(data.profile.audience)}
                </p>
              )}
              {isOwner && (
                <AppLink
                  className="text-link"
                  href={shell.hrefOf("knowledge-import")}
                >
                  {t.editProfile}
                </AppLink>
              )}
            </section>
          )}
          <div className="knowledge-filters">
            <Field label={t.search}>
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </Field>
            <Field label={t.all}>
              <select
                className={inputClass}
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
              >
                <option value="">{t.all}</option>
                {topics.map((x) => (
                  <option key={x} value={x}>
                    {t[x]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {!filtered.length && !shownOldFacts.length ? (
            <Empty
              title={query || topic ? t.noMatch : review ? t.noReview : t.empty}
              description={review ? t.noReviewHint : t.emptyHint}
            />
          ) : (
            <div className="knowledge-statements">
              {filtered.map((p) => (
                <Proposal
                  key={`${p.id}:${p.version}`}
                  proposal={p}
                  review={review}
                  refresh={refresh}
                  t={t}
                />
              ))}
              {shownOldFacts.map((f) => (
                <article key={f.id} className="knowledge-statement">
                  <Badge tone="success">{t.accepted}</Badge>
                  <p>{String(f.data.value)}</p>
                  <details>
                    <summary>{t.evidence}</summary>
                    <p>{String(f.data.key)}</p>
                    <AppLink
                      className="text-link"
                      href={shell.hrefOf("knowledge-facts") + "?expert=1"}
                    >
                      {t.facts}
                    </AppLink>
                  </details>
                </article>
              ))}
            </div>
          )}
          {review &&
            data.facts.some((f) => f.data.status === "conflicting") && (
              <AppLink
                className="text-link"
                href={shell.hrefOf("knowledge-conflicts") + "?expert=1"}
              >
                {t.legacyReview}
              </AppLink>
            )}
        </>
      )}
      <details className="knowledge-advanced">
        <summary>{t.advanced}</summary>
        <nav aria-label={t.advanced}>
          {(
            [
              ["facts", t.facts],
              ["library", t.library],
              ["health", t.health],
              ["inspector", t.inspector],
              ["impact", t.impact],
              ["import", t.advancedImport],
            ] as const
          ).map(([key, label]) => (
            <AppLink
              key={key}
              className="text-link"
              href={shell.hrefOf(`knowledge-${key}`) + "?expert=1"}
            >
              {label}
            </AppLink>
          ))}
        </nav>
      </details>
    </div>
  );
}
// Rendered only by the gate's legacy fallback; the gate recognizes explicit expert links.
function LegacyExpert({ tab }: { tab: KnowledgeTab }) {
  const { locale } = useWorkspace();
  return (
    <p>
      {knowledgeCopy[locale].advanced}: {tab}
    </p>
  );
}
function SourceList({
  data,
  refresh,
  t,
}: {
  data: Summary;
  refresh: () => void;
  t: KnowledgeCopy;
}) {
  const { project, locale, isOwner } = useWorkspace();
  const shell = useShell();
  const mutation = useMutation(refresh);
  const refreshSource = async (d: Entity) => {
    const p = await mutation.run(() =>
      action<Preview>(project.id, "knowledge-draft-preview", { draftId: d.id }),
    );
    if (p)
      window.location.assign(
        `${shell.hrefOf("knowledge-import")}?draft=${d.id}&preview=${p.id}`,
      );
  };
  return (
    <section className="stack-gap">
      {!data.drafts.length && !data.sources.length && (
        <Empty title={t.noSources} description={t.emptyHint} />
      )}
      {mutation.error && <WorkspaceError code={mutation.error} t={t} />}
      {data.drafts.map((d) => {
        const i = d.data.input as KnowledgeDraft;
        const active = data.runs.find((r) => r.id === d.data.activeRunId);
        return (
          <article className="knowledge-source" key={d.id}>
            <div>
              <h2>{i.name}</h2>
              <p>
                {t[i.kind]}
                {i.repository ? ` · ${i.repository}` : ""}
              </p>
              <Badge>
                {workspaceStatus(
                  String(active?.data.status ?? d.data.status),
                  t,
                )}
              </Badge>
              <p>
                {t.lastRead}: {when(d.data.lastSuccessfulSyncAt, locale)}
              </p>
              {active && <p role="status">{t.runningHint}</p>}
              {data.proposals.some((p) => p.data.draftId === d.id) && (
                <details>
                  <summary>{t.history}</summary>
                  {data.proposals
                    .filter((p) => p.data.draftId === d.id)
                    .map((p) => (
                      <Proposal
                        key={p.id}
                        proposal={p}
                        review={false}
                        refresh={refresh}
                        t={t}
                      />
                    ))}
                </details>
              )}

              {data.proposals
                .filter((p) => p.data.draftId === d.id && p.data.sourceId)
                .map((p) => (
                  <AppLink
                    key={p.id}
                    className="text-link"
                    href={`${shell.hrefOf("knowledge-library")}?source=${p.data.sourceId}`}
                  >
                    {t.library}
                  </AppLink>
                ))}
            </div>
            {isOwner && (
              <div className="form-actions">
                <Button
                  variant="outline"
                  disabled={mutation.pending || Boolean(active)}
                  onClick={() => refreshSource(d)}
                >
                  <RefreshCw aria-hidden="true" />
                  {t.update}
                </Button>
                <AppLink
                  className="text-link"
                  href={`${shell.hrefOf("knowledge-import")}?draft=${d.id}`}
                >
                  {t.resume}
                </AppLink>
              </div>
            )}
          </article>
        );
      })}
      {data.sources
        .filter((s) => !s.data.proposalId && s.data.status !== "revoked")
        .map((s) => (
          <article className="knowledge-source" key={s.id}>
            <div>
              <h2>{String(s.data.name)}</h2>
              <p>
                {t.lastRead}: {when(s.data.lastSuccessfulSyncAt, locale)}
              </p>
            </div>
            <AppLink
              className="text-link"
              href={`${shell.hrefOf("knowledge-library")}?source=${s.id}`}
            >
              {t.library}
            </AppLink>
          </article>
        ))}
    </section>
  );
}
function Proposal({
  proposal: p,
  review,
  refresh,
  t,
}: {
  proposal: Entity;
  review: boolean;
  refresh: () => void;
  t: KnowledgeCopy;
}) {
  const { project, isOwner, locale } = useWorkspace();
  const mutation = useMutation(refresh);
  const d = p.data as Record<string, any>;
  const [statement, setStatement] = useState(String(d.statement));
  const [publicUse, setPublicUse] = useState(false);
  const [marketing, setMarketing] = useState(true);
  const [support, setSupport] = useState(true);
  const [history, setHistory] = useState(false);
  const decide = (decision: "accept" | "reject") =>
    mutation.run(() =>
      action(project.id, "knowledge-proposal-decide", {
        proposalId: p.id,
        version: p.version,
        decision,
        statement,
        publicUse,
        audiences: [
          ...(marketing ? ["marketing"] : []),
          ...(support ? ["support"] : []),
        ],
      }),
    );
  return (
    <article className="knowledge-statement">
      <div className="knowledge-badges">
        <Badge tone={d.status === "accepted" ? "success" : "warning"}>
          {workspaceStatus(String(d.status), t)}
        </Badge>
        <span>{t[d.topic as keyof KnowledgeCopy]}</span>
        <span>{workspaceStatus(String(d.stage), t)}</span>
      </div>
      <h2>{String(d.statement)}</h2>
      {review && <p>{String(d.reason)}</p>}
      <details>
        <summary>{t.evidence}</summary>
        <p>{t.stageHint}</p>
        {d.evidence && (
          <>
            <p>
              {String(d.evidence.path)} · {String(d.evidence.startLine)}–
              {String(d.evidence.endLine)}
            </p>
            {d.evidence.commit && (
              <p className="knowledge-path">
                {t.commit}: {String(d.evidence.commit)}
              </p>
            )}
            <blockquote className="knowledge-quote">
              {String(d.evidence.quote)}
            </blockquote>
            {d.evidence.url && (
              <a
                className="text-link"
                href={String(d.evidence.url)}
                target="_blank"
                rel="noreferrer"
              >
                {t.evidence}
                <ExternalLink aria-hidden="true" />
              </a>
            )}
          </>
        )}
        {d.status === "accepted" && (
          <p>
            {d.publicUse ? t.public : t.internal} ·{" "}
            {((d.audiences as string[]) ?? [])
              .map((a) => t[a as keyof KnowledgeCopy])
              .join(", ")}
          </p>
        )}
        <Button variant="ghost" onClick={() => setHistory(!history)}>
          {t.loadHistory}
        </Button>
        {history && <ProposalHistory id={p.id} t={t} locale={locale} />}
      </details>
      {review && isOwner && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void decide("accept");
          }}
          className="stack-gap"
        >
          {d.status !== "needs_review" && (
            <>
              <Field label={t.statement}>
                <Textarea
                  required
                  maxLength={1000}
                  value={statement}
                  onChange={(e) => setStatement(e.target.value)}
                />
              </Field>
              <fieldset className="knowledge-usage">
                <legend>{t.usage}</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={marketing}
                    onChange={(e) => setMarketing(e.target.checked)}
                  />
                  {t.marketing}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={support}
                    onChange={(e) => setSupport(e.target.checked)}
                  />
                  {t.support}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={publicUse}
                    onChange={(e) => setPublicUse(e.target.checked)}
                  />
                  {t.publicUse}
                </label>
              </fieldset>
            </>
          )}
          {mutation.error && <WorkspaceError code={mutation.error} t={t} />}
          <div className="form-actions">
            {d.status !== "needs_review" && (
              <Button
                type="submit"
                disabled={mutation.pending || (!marketing && !support)}
              >
                <CheckCircle2 aria-hidden="true" />
                {t.accept}
              </Button>
            )}
            <Button
              variant="outline"
              type="button"
              disabled={mutation.pending}
              onClick={() => decide("reject")}
            >
              {t.reject}
            </Button>
          </div>
        </form>
      )}
      {review && d.status === "needs_review" && (
        <p>
          {t.update}: {t.sources}
        </p>
      )}
    </article>
  );
}
function ProposalHistory({
  id,
  t,
  locale,
}: {
  id: string;
  t: KnowledgeCopy;
  locale: string;
}) {
  const { project } = useWorkspace();
  const r = useResource<{
    items: { version: number; createdAt: string; data: Record<string, any> }[];
  }>(`/projects/${project.id}/knowledge/proposals/${id}/history`);
  return (
    <section aria-label={t.history}>
      {r.loading ? (
        <Loading label={t.history} />
      ) : r.error ? (
        <Alert kind="error">{t.unavailable}</Alert>
      ) : (
        <ol>
          {r.data?.items.map((v) => (
            <li key={v.version}>
              {t.version} {v.version} · {when(v.createdAt, locale)} ·{" "}
              {workspaceStatus(String(v.data.status), t)}
              <p>{String(v.data.statement ?? "")}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function WorkspaceError({
  code,
  t,
}: {
  code: string;
  t: KnowledgeCopy;
}) {
  const { locale } = useWorkspace();
  const de = locale === "de";
  // ApiError.message is humanized by the transport; worker errors retain codes.
  const normalizedCode = code.replaceAll(" ", "_");
  const known: Record<string, string> = {
    KNOWLEDGE_OUTPUT_LIMIT: de
      ? "Die Modellantwort wurde am Antwortlimit abgeschnitten. Es wurde kein Wissen übernommen. Erstelle eine neue Vorschau mit weniger Dateien oder passe das Antwortlimit der Analyse-Route an."
      : "The model response reached its output limit. No knowledge was accepted. Preview fewer files or adjust the analysis route's output limit.",
    MODEL_CAPABILITY_NOT_VERIFIED: de
      ? "Die Analyse-Route verwendet ein nicht freigegebenes Modell. Prüfe unter Einstellungen → KI den Standardprovider und die Aufgaben-Routen."
      : "The analysis route uses an unverified model. Check the default provider and task routes under Settings → AI.",
    VERIFIED_PRICE_CONFIGURATION_REQUIRED: de
      ? "Für das ausgewählte Modell fehlt ein aktueller verifizierter Preis. Prüfe die KI-Einstellungen."
      : "The selected model needs a current verified price. Check AI settings.",
    GITHUB_INVALID_PRIVATE_KEY: de
      ? "Füge den vollständigen Inhalt der privaten PEM-Datei ein, einschließlich BEGIN- und END-Zeile. Ein SHA256-Fingerabdruck reicht nicht aus."
      : "Paste the complete private PEM file, including its BEGIN and END lines. A SHA256 fingerprint is not sufficient.",
    KNOWLEDGE_MODEL_NOT_CONFIGURED: de
      ? "Für die KI-Analyse fehlt ein eingerichteter Modellanbieter. Hinterlege den Zugang unter Einstellungen → KI."
      : "AI analysis needs a configured model provider. Add its credentials under Settings → AI.",
    KNOWLEDGE_PREVIEW_EXPIRED: t.previewExpired,
    KNOWLEDGE_ANALYSIS_IN_PROGRESS: de
      ? "Eine KI-Analyse läuft bereits. Warte ihren Abschluss ab und versuche es danach erneut."
      : "An AI analysis is already running. Wait for it to finish, then try again.",
    KNOWLEDGE_FILE_TYPE_UNSUPPORTED: t.fileHint,
    KNOWLEDGE_FILE_SIZE_INVALID: t.fileHint,
    KNOWLEDGE_OUTPUT_INVALID: de
      ? "Die Analyse lieferte keine gültigen Vorschläge. Prüfe die Dateiauswahl und starte eine neue Analyse."
      : "The analysis returned invalid proposals. Review the file selection and start a new analysis.",
    KNOWLEDGE_EVIDENCE_INVALID: de
      ? "Ein Vorschlag konnte nicht durch die angegebenen Textstellen belegt werden. Prüfe die Quelle und starte eine neue Analyse."
      : "A proposal could not be matched to its quoted evidence. Review the source and start a new analysis.",
    VERSION_CONFLICT: de
      ? "Dieser Eintrag wurde inzwischen geändert. Lade die Seite neu und prüfe den aktuellen Stand."
      : "This entry changed. Reload and review the current version.",
    POLICY_REQUIRED: de
      ? "Für KI-Analysen fehlt eine KI-Ausgabenfreigabe. Ein Owner legt sie unter Einstellungen → KI & Budget fest."
      : "AI analysis needs an AI spending authority. An owner sets it under Settings → AI & budget.",
    MODEL_USE_FORBIDDEN: de
      ? "Bestätige die Weitergabe der ausgewählten Inhalte zur KI-Analyse."
      : "Confirm sending the selected content for AI analysis.",
    GITHUB_NOT_CONFIGURED: t.githubSetupHint,
    GITHUB_RECONNECT_REQUIRED: de
      ? "GitHub-Zugriff fehlt oder wurde entzogen. Verbinde dein Konto erneut."
      : "GitHub access is missing or revoked. Reconnect your account.",
    GITHUB_ACCESS_OR_RATE_LIMIT: de
      ? "GitHub verweigert den Abruf oder begrenzt Anfragen. Prüfe die Repository-Freigabe und versuche es später erneut."
      : "GitHub denied access or limited requests. Check repository permissions and try later.",
    KNOWLEDGE_COST_UNKNOWN: de
      ? "Der Modellaufruf hat einen unklaren Ausgang. Prüfe zuerst die Kosten in den Einstellungen; starte keine weitere Analyse."
      : "The model call has an uncertain outcome. Reconcile costs in Settings before another analysis.",
    KNOWLEDGE_NO_READABLE_FILES: de
      ? "Keine lesbaren Dateien ausgewählt. Wähle README.md oder ein Dokumentationsverzeichnis."
      : "No readable files selected. Select README.md or a documentation directory.",
    KNOWLEDGE_SENSITIVE_TEXT_EXCLUDED: de
      ? "Der Inhalt enthält mögliche Zugangsdaten. Entferne sie vor dem Import."
      : "Content contains possible credentials. Remove them before importing.",
    KNOWLEDGE_EVIDENCE_CHANGED: t.previewExpired,
    KNOWLEDGE_REFRESH_REQUIRED: t.previewExpired,
  };
  const budget = /BUDGET|COST_ESTIMATE|MODEL_NOT|RATE_CARD/.test(
    normalizedCode,
  );
  return (
    <Alert kind="error">
      {known[normalizedCode] ??
        (budget
          ? de
            ? "Modell oder Budget ist nicht bereit. Prüfe die KI-Einstellungen und die Budgetfreigabe."
            : "The model or budget is not ready. Check AI settings and budget approval."
          : `${t.errorPrefix} ${t.retry}.`)}
    </Alert>
  );
}

function KnowledgeWizard({
  data,
  refresh,
}: {
  data: Summary;
  refresh: () => void;
}) {
  const { project, locale, isOwner } = useWorkspace();
  const shell = useShell();
  const t = knowledgeCopy[locale];
  const [step, setStep] = useState(0);
  const [description, setDescription] = useState(
    String(data.profile.description ?? ""),
  );
  const [audience, setAudience] = useState(String(data.profile.audience ?? ""));
  const [draftId, setDraftId] = useState<string | null>(null);
  const [version, setVersion] = useState<number | undefined>();
  const [draft, setDraft] = useState<KnowledgeDraft>({
    name: "",
    description: "",
    audience: "",
    kind: "manual",
    text: "",
    paths: ["README.md", "docs/"],
    modelUse: false,
    language: locale,
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const mutation = useMutation();
  const [fileError, setFileError] = useState<string | null>(null);
  const persist = async () => {
    const saved = await mutation.run(() =>
      action<Entity>(project.id, "knowledge-draft-save", {
        ...draft,
        name: draft.name || project.name,
        ...(draftId ? { id: draftId, version } : {}),
        partial: true,
        description,
        audience,
      }),
    );
    if (saved) {
      setDraftId(saved.id);
      setVersion(saved.version);
      refresh();
      return saved.id;
    }
    return null;
  };
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("draft");
    const existing = data.drafts.find((d) => d.id === id);
    if (existing) {
      setDraftId(existing.id);
      setVersion(existing.version);
      setDraft(existing.data.input as KnowledgeDraft);
      setStep(1);
      if (existing.data.activeRunId) {
        setRunId(String(existing.data.activeRunId));
        setStep(3);
      }
    }
    if (params.get("preview")) {
      void mutation
        .run(() =>
          api<Preview>(
            `/projects/${project.id}/knowledge/previews/${encodeURIComponent(params.get("preview")!)}`,
          ),
        )
        .then((p) => {
          if (p) {
            setPreview(p);
            setStep(2);
          }
        });
    }
    if (params.get("github") === "connected") {
      setDraft((d) => ({ ...d, kind: "github" }));
      setStep(1);
    }
  }, []);
  const change = (v: Partial<KnowledgeDraft>) => {
    setDraft((d) => ({ ...d, ...v }));
    setPreview(null);
  };
  const saveSource = async (e: FormEvent) => {
    e.preventDefault();
    const saved = await mutation.run(() =>
      action<Entity>(project.id, "knowledge-draft-save", {
        ...draft,
        ...(draftId ? { id: draftId, version } : {}),
        description,
        audience,
      }),
    );
    if (!saved) return;
    setDraftId(saved.id);
    setVersion(saved.version);
    const p = await mutation.run(() =>
      action<Preview>(project.id, "knowledge-draft-preview", {
        draftId: saved.id,
      }),
    );
    refresh();
    if (p) {
      setPreview(p);
      setStep(2);
    }
  };
  const begin = async () => {
    if (!preview) return;
    const run = await mutation.run(() =>
      action<Entity>(project.id, "knowledge-analysis-start", {
        previewId: preview.id,
      }),
    );
    if (run) {
      setRunId(run.id);
      setStep(3);
      refresh();
    }
  };
  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setFileError(null);
    if (file.size > 1_000_000) {
      setFileError(t.fileHint);
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const result = await mutation.run(() =>
      action<{ text: string }>(project.id, "knowledge-file-read", {
        name: file.name,
        base64: btoa(binary),
      }),
    );
    if (result) change({ name: draft.name || file.name, text: result.text });
  };
  const run = data.runs.find((r) => r.id === runId);
  if (!isOwner) return <Alert>{t.readOnly}</Alert>;
  return (
    <div className="knowledge-workspace stack-gap">
      <header className="knowledge-heading">
        <div>
          <h1>{t.setup}</h1>
          <p>{t.setupLater}</p>
        </div>
        <Button
          variant="ghost"
          disabled={mutation.pending}
          onClick={async () => {
            const saved = await mutation.run(() =>
              action(project.id, "knowledge-profile-save", {
                description,
                audience,
                step,
              }),
            );
            if (saved && (await persist()))
              window.location.assign(shell.hrefOf("knowledge"));
          }}
        >
          {t.skip}
        </Button>
      </header>
      <ol className="knowledge-steps" aria-label={t.progress}>
        {[t.step1, t.step2, t.step3, t.step4].map((label, i) => (
          <li key={label} aria-current={step === i ? "step" : undefined}>
            <span>{i + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      {mutation.error && <WorkspaceError code={mutation.error} t={t} />}
      {step === 0 && (
        <form
          className="knowledge-form stack-gap"
          onSubmit={async (e) => {
            e.preventDefault();
            const saved = await mutation.run(() =>
              action(project.id, "knowledge-profile-save", {
                description,
                audience,
                step: 1,
              }),
            );
            if (saved) {
              setStep(1);
              refresh();
            }
          }}
        >
          <h2>{project.name}</h2>
          <Field label={t.projectDescription}>
            <Textarea
              value={description}
              maxLength={2000}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field label={t.projectAudience}>
            <Textarea
              value={audience}
              maxLength={1000}
              onChange={(e) => setAudience(e.target.value)}
            />
          </Field>
          <Button disabled={mutation.pending}>{t.save}</Button>
        </form>
      )}
      {step === 1 && (
        <form className="knowledge-form stack-gap" onSubmit={saveSource}>
          <Field label={t.kind}>
            <select
              className="input"
              value={draft.kind}
              onChange={(e) =>
                change({
                  kind: e.target.value as KnowledgeDraft["kind"],
                  text: "",
                  modelUse: false,
                })
              }
            >
              {(["manual", "file", "website", "github"] as const).map((k) => (
                <option key={k} value={k}>
                  {t[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t.sourceName}>
            <Input
              required
              maxLength={200}
              value={draft.name}
              onChange={(e) => change({ name: e.target.value })}
              placeholder={
                locale === "de"
                  ? "FamilyPlan – Produktdokumentation"
                  : "FamilyPlan — product documentation"
              }
            />
          </Field>
          {draft.kind === "github" ? (
            <GithubSource
              draft={draft}
              change={change}
              t={t}
              beforeConnect={persist}
            />
          ) : draft.kind === "website" ? (
            <Field label={t.url}>
              <Input
                type="url"
                required
                value={draft.url ?? ""}
                onChange={(e) => change({ url: e.target.value })}
              />
            </Field>
          ) : (
            <>
              {draft.kind === "file" && (
                <Field label={t.fileHint}>
                  <Input
                    type="file"
                    accept=".md,.txt,.html,.pdf"
                    onChange={(e) => readFile(e.target.files?.[0])}
                  />
                </Field>
              )}
              <Field label={t.text}>
                <Textarea
                  required
                  maxLength={100000}
                  rows={10}
                  value={draft.text}
                  onChange={(e) => change({ text: e.target.value })}
                />
              </Field>
            </>
          )}
          {fileError && <Alert kind="error">{fileError}</Alert>}
          <label className="knowledge-check">
            <input
              type="checkbox"
              checked={draft.modelUse}
              onChange={(e) => change({ modelUse: e.target.checked })}
            />
            {t.modelUse}
          </label>
          <p>{t.modelHint}</p>
          <div className="form-actions">
            <Button type="button" variant="outline" onClick={() => setStep(0)}>
              {t.back}
            </Button>
            <Button disabled={mutation.pending}>{t.preview}</Button>
          </div>
        </form>
      )}
      {step === 2 && preview && (
        <section className="knowledge-form stack-gap">
          <h2>{t.consent}</h2>
          <p>{t.previewHint}</p>
          {preview.partial && (
            <Alert kind="warning">
              {t.partial} {t.omitted}: {preview.skipped}
            </Alert>
          )}
          <p>
            {t.files}: {preview.files.length} · {t.characters}:{" "}
            {preview.characters.toLocaleString(locale)}
          </p>
          {preview.commit && (
            <p className="knowledge-path">
              {t.commit}: {preview.commit}
            </p>
          )}
          <ul>
            {preview.files.map((f) => (
              <li key={f.path} className="knowledge-path">
                {f.path} · {f.characters.toLocaleString(locale)} {t.characters}
              </li>
            ))}
          </ul>
          <div className="form-actions">
            <Button variant="outline" onClick={() => setStep(1)}>
              {t.back}
            </Button>
            <Button disabled={mutation.pending} onClick={begin}>
              {preview.modelRequired || draft.modelUse
                ? t.start
                : t.manualReview}
            </Button>
          </div>
        </section>
      )}
      {step === 3 && (
        <section className="knowledge-form stack-gap">
          <h2>{t.result}</h2>
          <p role="status">
            {workspaceStatus(String(run?.data.status ?? "queued"), t)}
          </p>
          {Boolean(run?.data.error) && (
            <WorkspaceError code={String(run?.data.error)} t={t} />
          )}
          {run?.data.status === "completed" ? (
            <>
              {run.data.proposalCount === 0 && <p>{t.noProposal}</p>}
              <AppLink
                className="button button-primary"
                href={shell.hrefOf("knowledge-review")}
              >
                {t.reviewNow}
              </AppLink>
            </>
          ) : (
            <p>{t.runningHint}</p>
          )}
          {run && ["queued", "analyzing"].includes(String(run.data.status)) && (
            <Button
              variant="outline"
              disabled={mutation.pending}
              onClick={async () => {
                await mutation.run(() =>
                  action(project.id, "knowledge-analysis-cancel", {
                    runId: run.id,
                  }),
                );
                refresh();
              }}
            >
              {t.cancel}
            </Button>
          )}
          {run && ["failed", "canceled"].includes(String(run.data.status)) && (
            <Button
              variant="outline"
              onClick={() => {
                const d = data.drafts.find((d) => d.id === draftId);
                if (d) setVersion(d.version);
                setStep(1);
              }}
            >
              {t.newPreview}
            </Button>
          )}
        </section>
      )}
    </div>
  );
}
function GithubSource({
  draft,
  change,
  t,
  beforeConnect,
}: {
  draft: KnowledgeDraft;
  change: (v: Partial<KnowledgeDraft>) => void;
  t: KnowledgeCopy;
  beforeConnect: () => Promise<string | null>;
}) {
  const { project } = useWorkspace();
  const status = useResource<Github>(
    `/projects/${project.id}/knowledge/github`,
  );
  const repositories = useResource<{ items: Repo[] }>(
    draft.connectionId
      ? `/projects/${project.id}/knowledge/github/repositories?connectionId=${draft.connectionId}`
      : null,
  );
  const mutation = useMutation(status.refresh);
  return (
    <div className="stack-gap">
      <h2>{t.githubSetup}</h2>
      <p>{t.githubSetupHint}</p>
      {status.loading && <Loading label={t.githubSetup} />}
      {status.error && <WorkspaceError code={status.error.message} t={t} />}
      <details open={!status.data?.configured}>
        <summary>{t.configure}</summary>
        <GithubConfiguration t={t} onSaved={status.refresh} />
      </details>
      {status.data?.configured && (
        <>
          <p>{t.configured}</p>
          <div className="form-actions">
            {status.data.installUrl && (
              <a
                className="text-link"
                target="_blank"
                rel="noreferrer"
                href={status.data.installUrl}
              >
                {t.install}
                <ExternalLink aria-hidden="true" />
              </a>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={mutation.pending}
              onClick={async () => {
                const draftId = await beforeConnect();
                if (!draftId) return;
                const result = await mutation.run(() =>
                  action<{ url: string }>(
                    project.id,
                    "knowledge-github-connect",
                    { draftId },
                  ),
                );
                if (result) window.location.assign(result.url);
              }}
            >
              {t.connect}
            </Button>
          </div>
        </>
      )}
      {mutation.error && <WorkspaceError code={mutation.error} t={t} />}
      <Field label={t.connection}>
        <select
          className="input"
          required
          value={draft.connectionId ?? ""}
          onChange={(e) =>
            change({
              connectionId: e.target.value,
              repositoryId: undefined,
              repository: undefined,
            })
          }
        >
          <option value="">{t.connection}</option>
          {status.data?.connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.account}
            </option>
          ))}
        </select>
      </Field>
      {repositories.loading && draft.connectionId && (
        <Loading label={t.loadRepos} />
      )}
      {repositories.error && (
        <WorkspaceError code={repositories.error.message} t={t} />
      )}
      {repositories.data && !repositories.data.items.length && (
        <Alert>{t.noRepos}</Alert>
      )}
      <Field label={t.repository}>
        <select
          className="input"
          required
          value={draft.repositoryId ?? ""}
          onChange={(e) => {
            const repo = repositories.data?.items.find(
              (r) => r.id === Number(e.target.value),
            );
            if (repo)
              change({
                repositoryId: repo.id,
                repository: repo.full_name,
                branch: repo.default_branch,
              });
          }}
        >
          <option value="">{t.selectRepo}</option>
          {repositories.data?.items.map((r) => (
            <option key={r.id} value={r.id}>
              {r.full_name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t.branch}>
        <Input
          value={draft.branch ?? ""}
          onChange={(e) => change({ branch: e.target.value || undefined })}
        />
      </Field>
      <Field label={t.paths}>
        <Textarea
          required
          value={draft.paths.join("\n")}
          onChange={(e) => change({ paths: e.target.value.split("\n") })}
        />
      </Field>
      <p>{t.pathsHint}</p>
    </div>
  );
}
function GithubConfiguration({
  t,
  onSaved,
}: {
  t: KnowledgeCopy;
  onSaved: () => void;
}) {
  const { project } = useWorkspace();
  const mutation = useMutation(onSaved);
  const [config, setConfig] = useState({
    appId: "",
    slug: "",
    clientId: "",
    clientSecret: "",
    privateKey: "",
  });
  // This section is embedded in the source form; use a button rather than a nested form.
  return (
    <div className="knowledge-app-settings stack-gap">
      {(
        ["appId", "slug", "clientId", "clientSecret", "privateKey"] as const
      ).map((k) => (
        <Field key={k} label={t[k]}>
          {k === "privateKey" ? (
            <Textarea
              autoComplete="off"
              value={config[k]}
              onChange={(e) => setConfig({ ...config, [k]: e.target.value })}
            />
          ) : (
            <Input
              type={k === "clientSecret" ? "password" : "text"}
              autoComplete="off"
              value={config[k]}
              onChange={(e) => setConfig({ ...config, [k]: e.target.value })}
            />
          )}
        </Field>
      ))}
      {mutation.error && <WorkspaceError code={mutation.error} t={t} />}
      <Button
        type="button"
        variant="outline"
        disabled={mutation.pending}
        onClick={async () => {
          const saved = await mutation.run(() =>
            action(project.id, "knowledge-github-configure", config),
          );
          if (saved)
            setConfig({
              appId: "",
              slug: "",
              clientId: "",
              clientSecret: "",
              privateKey: "",
            });
        }}
      >
        {t.appSave}
      </Button>
    </div>
  );
}
