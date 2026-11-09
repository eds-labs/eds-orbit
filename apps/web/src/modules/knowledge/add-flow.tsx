"use client";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronRight } from "lucide-react";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { settingsSectionHref } from "@/platform/shell/settings-nav";
import { languageName } from "@/platform/project-settings/catalog";
import { AppLink } from "@/platform/ui/app-link";
import { cn } from "@/lib/utils";
import { action, useMutation, useResource, type Entity } from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Input,
  Textarea,
} from "@/components/ui/primitives";
import type { KnowledgeDraft } from "../../../../../packages/schemas/src/knowledge-workspace";
import {
  knowledgeCopy,
  pageCount as pagesText,
  workspaceStatus,
  type KnowledgeCopy,
} from "./workspace-text";
import {
  analysisRunning,
  costText,
  Field,
  knowledgeErrorText,
  siteRunActive,
  SiteRunSummary,
  visibleDrafts,
  WorkspaceError,
  type Preview,
  type Summary,
} from "./workspace-parts";
import { GithubSource } from "./github-page";

type Kind = KnowledgeDraft["kind"];
type Step = "what" | "content" | "use" | "result";
type Way = "whole" | "ai" | "statement";
type Site = {
  rootUrl: string;
  discovery: "sitemap" | "single";
  pages: { url: string; language: string }[];
  capped: boolean;
  complete: boolean;
};
type Rights = {
  marketing: boolean;
  support: boolean;
  publicUse: boolean;
  modelUse: boolean;
  autoUpdate: boolean;
};
type Preflight = {
  ready: boolean;
  blockers: string[];
  estimateMicros: number;
  model: string;
  provider: string;
  proposalLimit: number;
};
/** What is known about starting the analysis; the start button says which. */
export type Check =
  | { state: "preparing" }
  | { state: "unprepared" }
  | { state: "checking" }
  | { state: "failed"; code: string }
  | { state: "done"; result: Preflight };
type Outcome =
  | { kind: "analysis"; runId: string }
  | { kind: "content"; sourceId: string }
  | { kind: "site"; sourceId: string; pages: number; started: boolean };

const STATEMENT_LIMIT = 1000;
const AI_PAGE_LIMIT = 30;
const DEFAULT_RIGHTS: Rights = {
  marketing: true,
  support: true,
  publicUse: false,
  modelUse: true,
  autoUpdate: true,
};

export const canUseWhole = (kind: Kind) => kind !== "github";
export const canUseStatement = (kind: Kind, text: string) =>
  (kind === "manual" || kind === "file") &&
  text.trim().length > 0 &&
  text.length <= STATEMENT_LIMIT;

/**
 * The ways this content can be used, best first. `pages` is the number of
 * selected pages of a site, unset while no page list is known.
 */
function waysFor(kind: Kind, text: string, pages?: number): Way[] {
  const site = kind === "website";
  return [
    ...(canUseWhole(kind) && (!site || pages !== undefined)
      ? (["whole"] as const)
      : []),
    ...(!site || (pages ?? 0) <= AI_PAGE_LIMIT ? (["ai"] as const) : []),
    ...(canUseStatement(kind, text) ? (["statement"] as const) : []),
  ];
}

/** The chosen way if this content offers it, else the best one it does. */
export function normalWay(
  way: Way,
  kind: Kind,
  text: string,
  pages?: number,
): Way {
  const open = waysFor(kind, text, pages);
  return open.includes(way) ? way : open[0]!;
}

/** The rights and page choices an existing site source starts from. */
export function siteDefaults(source: Pick<Entity, "data">) {
  const d = source.data as Record<string, any>;
  const audiences: string[] | null = Array.isArray(d.audiences)
    ? d.audiences
    : null;
  return {
    marketing: audiences ? audiences.includes("marketing") : true,
    support: audiences ? audiences.includes("support") : true,
    publicUse: Boolean(d.publicUse),
    modelUse: d.modelUse !== false,
    // Only a site source records the owner's choice by leaving this out.
    autoUpdate: d.site ? Boolean(d.syncEveryHours) : true,
    excluded: (d.site?.excludedPages ?? []) as string[],
  };
}

const emptyDraft = (kind: Kind, language: "de" | "en"): KnowledgeDraft => ({
  name: "",
  description: "",
  audience: "",
  kind,
  text: "",
  paths: ["README.md", "docs/"],
  modelUse: false,
  language,
});

/** Where a link enters the flow. The URL is read once, when the page opens. */
export function initialFlow(
  params: Pick<URLSearchParams, "get"> | null,
  data: Summary,
  locale: "de" | "en",
) {
  const row = visibleDrafts(data.drafts).find(
    (d) => d.id === params?.get("draft"),
  );
  const input = row?.data.input as KnowledgeDraft | undefined;
  const previewId = params?.get("preview") ?? null;
  const source = data.sources.find(
    (s) =>
      s.id === params?.get("site") &&
      ["gitbook", "website"].includes(String(s.data.type)),
  );
  const prefill = source ? siteDefaults(source) : null;
  const github = params?.get("github") === "connected";
  // A preview alone names no content: only its analysis can be started.
  const kind: Kind = source
    ? "website"
    : (input?.kind ?? (github || previewId ? "github" : "manual"));
  const draft: KnowledgeDraft = source
    ? {
        ...emptyDraft("website", locale),
        name: String(source.data.name ?? ""),
        url: String(
          (source.data.site as { rootUrl?: string } | undefined)?.rootUrl ??
            (source.data.allowedOrigins as string[] | undefined)?.[0] ??
            "",
        ),
      }
    : (input ?? emptyDraft(kind, locale));
  const runId = row?.data.activeRunId ? String(row.data.activeRunId) : null;
  const step: Step = runId
    ? "result"
    : previewId
      ? "use"
      : row || source || github
        ? "content"
        : "what";
  // A preview or a run has already taken a way: continue on it.
  const taken = previewId ?? runId;
  const way: Way =
    kind === "github" ||
    (taken && (!input || input.modelUse || kind === "website"))
      ? "ai"
      : taken && canUseStatement(kind, draft.text)
        ? "statement"
        : "whole";
  return {
    step,
    draft,
    draftId: row?.id ?? null,
    version: row?.version,
    way,
    previewId,
    sourceId: source?.id ?? null,
    rights: prefill ?? { ...DEFAULT_RIGHTS, ...input?.rights },
    excluded: new Set(prefill?.excluded),
    sourceLanguage: source ? String(source.data.language ?? "") : "",
    outcome: runId ? ({ kind: "analysis", runId } as Outcome) : null,
  };
}

const withScheme = (address: string) =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(address.trim())
    ? address.trim()
    : `https://${address.trim()}`;

/** A page's address below the site root, without its language segment. */
function pageLabel(page: Site["pages"][number], rootUrl: string, home: string) {
  const root = new URL(rootUrl).pathname.replace(/\/+$/, "");
  const parts = new URL(page.url).pathname
    .slice(root.length)
    .split("/")
    .filter(Boolean);
  if (parts[0]?.toLowerCase() === page.language.toLowerCase()) parts.shift();
  return parts.join("/") || home;
}

export function WayPicker({
  kind,
  text,
  pages,
  value,
  onChange,
  disabled,
  t,
}: {
  kind: Kind;
  text: string;
  pages?: number;
  value: Way;
  onChange: (way: Way) => void;
  disabled: boolean;
  t: KnowledgeCopy;
}) {
  const site = kind === "website";
  const open = waysFor(kind, text, pages);
  const tooMany = site && !open.includes("ai");
  const options: { way: Way; label: string; hint: string }[] = [
    ...(open.includes("whole")
      ? [
          {
            way: "whole" as const,
            label: t.wayWhole,
            hint: site ? t.wayWholeSiteHint : t.wayWholeHint,
          },
        ]
      : []),
    {
      way: "ai",
      label: t.wayAi,
      hint: site ? t.waySiteAiHint : t.wayAiHint,
    },
    ...(open.includes("statement")
      ? [
          {
            way: "statement" as const,
            label: t.wayStatement,
            hint: t.wayStatementHint,
          },
        ]
      : []),
  ];
  // With one way there is nothing to choose, only something to explain.
  if (options.length === 1) return <p>{options[0]!.hint}</p>;
  return (
    <fieldset className="knowledge-ways" aria-label={t.useTitle}>
      {options.map((o) => {
        const off = o.way === "ai" && tooMany;
        return (
          <label
            key={o.way}
            className={cn("knowledge-way", off && "knowledge-way-off")}
          >
            <input
              type="radio"
              name="knowledge-way"
              value={o.way}
              checked={value === o.way}
              disabled={disabled || off}
              onChange={() => onChange(o.way)}
            />
            <span>
              <strong>
                {o.label}
                {site && o.way === "whole" && (
                  <Badge tone="blue">{t.recommended}</Badge>
                )}
              </strong>
              <small>
                {off ? t.aiTooManyPages.replace("{n}", String(pages)) : o.hint}
              </small>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

export function SitePagePicker({
  site,
  excluded,
  onChange,
  disabled,
  t,
}: {
  site: Site;
  excluded: Set<string>;
  onChange: (next: Set<string>) => void;
  disabled: boolean;
  t: KnowledgeCopy;
}) {
  const { locale } = useWorkspace();
  const groups = [...new Set(site.pages.map((p) => p.language))].map(
    (language) => ({
      language,
      pages: site.pages.filter((p) => p.language === language),
    }),
  );
  const selected = site.pages.filter((p) => !excluded.has(p.url)).length;
  const setPages = (urls: string[], on: boolean) => {
    const next = new Set(excluded);
    for (const url of urls) {
      if (on) next.delete(url);
      else next.add(url);
    }
    onChange(next);
  };
  const single = site.pages.length === 1;
  return (
    <section className="knowledge-pages stack-gap" aria-label={t.pagesTitle}>
      {single && <Alert>{t.singlePage}</Alert>}
      {site.capped && <Alert kind="warning">{t.cappedPages}</Alert>}
      {!site.complete && <Alert kind="warning">{t.incompletePages}</Alert>}
      <p role="status">
        {t.pagesSelected
          .replace("{n}", String(selected))
          .replace("{pages}", pagesText(site.pages.length, locale))}
      </p>
      {groups.map((group) => {
        const chosen = group.pages.filter((p) => !excluded.has(p.url)).length;
        const all = chosen === group.pages.length;
        return (
          <div key={group.language} className="knowledge-page-group">
            <label className="knowledge-check knowledge-page-all">
              <input
                type="checkbox"
                checked={all}
                disabled={disabled}
                ref={(box) => {
                  if (box) box.indeterminate = chosen > 0 && !all;
                }}
                onChange={(e) =>
                  setPages(
                    group.pages.map((p) => p.url),
                    e.target.checked,
                  )
                }
              />
              <span>
                {t.wholeLanguage
                  .replace("{language}", languageName(group.language, locale))
                  .replace("{pages}", pagesText(group.pages.length, locale))}
              </span>
            </label>
            <details open={site.pages.length <= 20}>
              <summary>{t.showPages}</summary>
              <ul>
                {group.pages.map((page) => (
                  <li key={page.url}>
                    <label className="knowledge-check">
                      <input
                        type="checkbox"
                        checked={!excluded.has(page.url)}
                        disabled={disabled}
                        onChange={(e) => setPages([page.url], e.target.checked)}
                      />
                      <span className="knowledge-path">
                        {pageLabel(page, site.rootUrl, t.homePage)}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        );
      })}
    </section>
  );
}

/** Blockers that an owner resolves in Settings → AI. */
const AI_SETTINGS_BLOCKERS = new Set([
  "POLICY_REQUIRED",
  "POLICY_INTERVAL_INVALID",
  "MODEL_CAPABILITY_NOT_VERIFIED",
  "VERIFIED_PRICE_CONFIGURATION_REQUIRED",
  "CURRENT_PRICE_REQUIRED",
  "ROUTE_EFFORT_UNSUPPORTED",
  "KNOWLEDGE_MODEL_NOT_CONFIGURED",
  "PAID_MANDATE_EXPIRED",
  "BUDGET_NOT_APPROVED",
  "BUDGET_EXCEEDED",
  "PROVIDER_BUDGET_STOP",
]);

/** The button is the owner's consent: it names the cost and the model. */
export function AnalysisStart({
  check,
  busy,
  onStart,
  onRetry,
  onNewPreview,
  startDisabled = false,
  t,
}: {
  check: Check;
  busy: boolean;
  startDisabled?: boolean;
  onStart: () => void;
  onRetry: () => void;
  onNewPreview: () => void;
  t: KnowledgeCopy;
}) {
  const { locale } = useWorkspace();
  const shell = useShell();
  const result = check.state === "done" ? check.result : null;
  const label =
    check.state === "preparing"
      ? t.preparing
      : check.state === "checking"
        ? t.checkingCost
        : result?.model
          ? t.startAi
              .replace("{cost}", costText(result.estimateMicros, t))
              .replace("{model}", result.model)
          : t.start;
  const linkOf = (code: string) =>
    AI_SETTINGS_BLOCKERS.has(code)
      ? {
          href: settingsSectionHref(shell.hrefOf("settings"), "ai"),
          text: t.aiSettingsLink,
        }
      : code === "MODEL_USE_FORBIDDEN"
        ? { href: shell.hrefOf("knowledge-sources"), text: t.sourcesLink }
        : null;
  return (
    <div className="stack-gap">
      {check.state === "failed" && <WorkspaceError code={check.code} t={t} />}
      {(check.state === "failed" || check.state === "unprepared") && (
        <div>
          <Button variant="outline" disabled={busy} onClick={onRetry}>
            {t.retry}
          </Button>
        </div>
      )}
      {result?.blockers.map((code) => {
        const link = linkOf(code);
        return (
          <Alert kind="warning" key={code}>
            <p>{knowledgeErrorText(code, t, locale === "de")}</p>
            {link && (
              <AppLink className="text-link" href={link.href}>
                {link.text}
              </AppLink>
            )}
            {code === "KNOWLEDGE_PREVIEW_EXPIRED" && (
              <Button variant="outline" disabled={busy} onClick={onNewPreview}>
                {t.newPreview}
              </Button>
            )}
          </Alert>
        );
      })}
      {result?.ready && result.model && result.proposalLimit > 0 && (
        <p>{t.proposalLimit.replace("{n}", String(result.proposalLimit))}</p>
      )}
      <div>
        <Button
          className="knowledge-start"
          disabled={busy || startDisabled || !result?.ready}
          onClick={onStart}
        >
          {label}
        </Button>
      </div>
    </div>
  );
}

/** Add-knowledge page. Readers get the explanation and no working control. */
export function KnowledgeAddFlow({
  data,
  refresh,
}: {
  data: Summary;
  refresh: () => void;
}) {
  const { locale, isOwner } = useWorkspace();
  const profile = useSearchParams()?.get("profile") === "1";
  const t = knowledgeCopy[locale];
  if (!isOwner) return <Alert>{t.readOnly}</Alert>;
  return profile ? (
    <ProfileForm data={data} t={t} />
  ) : (
    <Flow data={data} refresh={refresh} t={t} />
  );
}

function ProfileForm({ data, t }: { data: Summary; t: KnowledgeCopy }) {
  const { project } = useWorkspace();
  const shell = useShell();
  const mutation = useMutation();
  const [description, setDescription] = useState(
    String(data.profile.description ?? ""),
  );
  const [audience, setAudience] = useState(String(data.profile.audience ?? ""));
  return (
    <div className="knowledge-workspace stack-gap">
      <header className="knowledge-heading">
        <div>
          <h1>{t.editProfile}</h1>
          <p>{t.profileHint}</p>
        </div>
      </header>
      {mutation.error && <WorkspaceError code={mutation.error} t={t} />}
      <form
        className="knowledge-form stack-gap"
        onSubmit={async (e) => {
          e.preventDefault();
          const saved = await mutation.run(() =>
            action(project.id, "knowledge-profile-save", {
              description,
              audience,
            }),
          );
          if (saved) window.location.assign(shell.hrefOf("knowledge"));
        }}
      >
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
        <div className="form-actions">
          <Button asChild variant="outline">
            <AppLink href={shell.hrefOf("knowledge")}>{t.back}</AppLink>
          </Button>
          <Button type="submit" disabled={mutation.pending}>
            {t.save}
          </Button>
        </div>
      </form>
    </div>
  );
}

function Flow({
  data,
  refresh,
  t,
}: {
  data: Summary;
  refresh: () => void;
  t: KnowledgeCopy;
}) {
  const { project, locale } = useWorkspace();
  const shell = useShell();
  const params = useSearchParams();
  const [init] = useState(() => initialFlow(params, data, locale));
  const [step, setStep] = useState<Step>(init.step);
  const [draft, setDraft] = useState<KnowledgeDraft>(init.draft);
  const [draftId, setDraftId] = useState(init.draftId);
  const [version, setVersion] = useState(init.version);
  const [way, setWay] = useState<Way>(init.way);
  const [sourceId, setSourceId] = useState(init.sourceId);
  const [site, setSite] = useState<Site | null>(null);
  const [excluded, setExcluded] = useState(init.excluded);
  const [rights, setRights] = useState(init.rights);
  const [outcome, setOutcome] = useState(init.outcome);
  const [fileError, setFileError] = useState<string | null>(null);
  const mutation = useMutation();
  // The preview of a `?preview=` link stands until the content changes.
  const [linkDropped, setLinkDropped] = useState(false);
  const linked = useResource<Preview>(
    init.previewId
      ? `/projects/${project.id}/knowledge/previews/${encodeURIComponent(init.previewId)}`
      : null,
  );
  const [built, setBuilt] = useState<Preview | null>(null);
  const preview =
    built ?? (init.previewId && !linkDropped ? linked.data : null) ?? null;
  const dropPreview = () => {
    setBuilt(null);
    setLinkDropped(true);
  };
  const selected =
    site?.pages.filter((p) => !excluded.has(p.url)).map((p) => p.url) ?? [];
  const pageCount = site ? selected.length : undefined;

  const [checked, setChecked] = useState<{
    previewId: string;
    check: Check;
  } | null>(null);
  const [checkAttempt, setCheckAttempt] = useState(0);
  const toCheck = step === "use" && way === "ai" ? preview?.id : undefined;
  useEffect(() => {
    if (!toCheck) return;
    let current = true;
    const report = (check: Check) => {
      if (current) setChecked({ previewId: toCheck, check });
    };
    action<Preflight>(project.id, "knowledge-analysis-preflight", {
      previewId: toCheck,
    }).then(
      (result) => report({ state: "done", result }),
      (e: Error) => report({ state: "failed", code: e.message }),
    );
    return () => {
      current = false;
    };
  }, [project.id, toCheck, checkAttempt]);
  const check: Check = preview
    ? checked?.previewId === preview.id
      ? checked.check
      : { state: "checking" }
    : mutation.pending || linked.loading
      ? { state: "preparing" }
      : mutation.error || linked.error
        ? { state: "unprepared" }
        : { state: "preparing" };

  // After a step change the keyboard and screen reader start at its heading.
  const heading = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);

  const change = (v: Partial<KnowledgeDraft>) => {
    setDraft((d) => ({ ...d, ...v }));
    dropPreview();
  };
  // An error belongs to the step it happened on.
  const goBack = (to: Step) => {
    mutation.clear();
    setStep(to);
  };
  const chooseKind = (kind: Kind) => {
    mutation.clear();
    setDraft(emptyDraft(kind, locale));
    setDraftId(null);
    setVersion(undefined);
    setSourceId(null);
    setSite(null);
    setExcluded(new Set());
    setRights(DEFAULT_RIGHTS);
    setWay(kind === "github" ? "ai" : "whole");
    dropPreview();
    setStep("content");
  };
  const draftInput = (modelUse: boolean, chosen = rights) => ({
    ...draft,
    modelUse,
    rights: {
      marketing: chosen.marketing,
      support: chosen.support,
      publicUse: chosen.publicUse,
      modelUse: chosen.modelUse,
    },
    description: String(data.profile.description ?? ""),
    audience: String(data.profile.audience ?? ""),
    ...(draft.kind === "website" && site
      ? { url: site.rootUrl, pages: selected }
      : {}),
  });
  /** Versions only grow, and the run or the page may have moved this one on. */
  const draftVersion = () =>
    Math.max(
      version ?? 0,
      data.drafts.find((d) => d.id === draftId)?.version ?? 0,
    );
  const persist = async () => {
    const saved = await mutation.run(() =>
      action<Entity>(project.id, "knowledge-draft-save", {
        ...draftInput(true),
        name: draft.name || project.name,
        ...(draftId ? { id: draftId, version: draftVersion() } : {}),
        partial: true,
      }),
    );
    if (!saved) return null;
    setDraftId(saved.id);
    setVersion(saved.version);
    refresh();
    return saved.id;
  };
  const buildPreview = async (modelUse: boolean, chosen = rights) => {
    const saved = await mutation.run(() =>
      action<Entity>(project.id, "knowledge-draft-save", {
        ...draftInput(modelUse, chosen),
        ...(draftId ? { id: draftId, version: draftVersion() } : {}),
      }),
    );
    if (!saved) return null;
    setDraftId(saved.id);
    setVersion(saved.version);
    const built = await mutation.run(() =>
      action<Preview>(project.id, "knowledge-draft-preview", {
        draftId: saved.id,
      }),
    );
    refresh();
    return built ?? null;
  };
  // A preview from a link alone: no draft to save a choice to.
  const previewOnly = !draftId && Boolean(init.previewId) && !draft.name;
  const prepareAi = async (chosen = rights) => {
    if (previewOnly) {
      setStep("what");
      return;
    }
    dropPreview();
    const next = await buildPreview(true, chosen);
    if (next) setBuilt(next);
  };
  // A preview belongs to the saved draft, so a changed right needs a new one.
  const changeRights = (next: Rights) => {
    setRights(next);
    if (!preview) return;
    if (way === "ai") void prepareAi(next);
    else dropPreview();
  };
  const chooseWay = (next: Way) => {
    setWay(next);
    if (next === "ai" && !preview) void prepareAi();
  };
  const enterUse = (fresh = false) => {
    const next = normalWay(way, draft.kind, draft.text, pageCount);
    setWay(next);
    setStep("use");
    if (next === "ai" && (fresh || !preview)) void prepareAi();
  };
  const discover = async (e?: FormEvent) => {
    e?.preventDefault();
    const found = await mutation.run(() =>
      action<Site & { excludedPages: string[] }>(
        project.id,
        "knowledge-site-discover",
        sourceId ? { sourceId } : { url: withScheme(draft.url ?? "") },
      ),
    );
    if (!found) return;
    setSite(found);
    dropPreview();
    setExcluded(
      new Set(
        sourceId
          ? found.excludedPages
          : draft.pages?.length
            ? found.pages
                .map((p) => p.url)
                .filter((url) => !draft.pages!.includes(url))
            : [],
      ),
    );
  };
  useEffect(() => {
    if (init.sourceId) void discover();
  }, []);
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
  const startAnalysis = async (previewId: string, confirm: boolean) => {
    const run = await mutation.run(() =>
      action<Entity>(project.id, "knowledge-analysis-start", {
        previewId,
        ...(confirm ? { confirmModelUse: true } : {}),
      }),
    );
    if (!run) {
      // What refused the start is also what the check reports, with its control.
      setChecked(null);
      setCheckAttempt((n) => n + 1);
      return;
    }
    setOutcome({ kind: "analysis", runId: run.id });
    setStep("result");
    refresh();
  };
  const submitStatement = async () => {
    const next = await buildPreview(false);
    if (next) await startAnalysis(next.id, false);
  };
  const takeOverContent = async () => {
    const { autoUpdate: _weekly, ...use } = rights;
    const source = await mutation.run(() =>
      action<Entity>(project.id, "knowledge-content-accept", {
        name: draft.name,
        text: draft.text,
        kind: draft.kind,
        language: project.language,
        ...use,
        ...(draftId ? { draftId } : {}),
      }),
    );
    if (!source) return;
    setOutcome({ kind: "content", sourceId: source.id });
    setStep("result");
    refresh();
  };
  const readSite = async () => {
    if (!site) return;
    const started = await mutation.run(() =>
      action<{ sourceId: string; run: Entity; started: boolean }>(
        project.id,
        "knowledge-site-start",
        {
          ...(sourceId ? { sourceId } : { url: site.rootUrl }),
          name: draft.name,
          excludedPages: site.pages
            .map((p) => p.url)
            .filter((url) => excluded.has(url)),
          ...rights,
          language: init.sourceLanguage || project.language,
          ...(draftId ? { draftId } : {}),
        },
      ),
    );
    if (!started) return;
    setOutcome({
      kind: "site",
      sourceId: started.sourceId,
      pages: selected.length,
      started: started.started,
    });
    setStep("result");
    refresh();
  };

  const busy = mutation.pending;
  const noAudience = !rights.marketing && !rights.support;
  // A blocker below already says this, together with what to do about it.
  const shownBelow =
    check.state === "done" &&
    check.result.blockers.includes(mutation.error?.replaceAll(" ", "_") ?? "");
  const titles: Record<Step, string> = {
    what: t.whatTitle,
    content:
      draft.kind === "manual"
        ? t.contentManual
        : draft.kind === "file"
          ? t.contentFile
          : draft.kind === "website"
            ? t.contentWebsite
            : t.contentGithub,
    use: t.useTitle,
    result: t.result,
  };
  const current = step === "use" ? 1 : step === "result" ? 2 : 0;
  const isSite = draft.kind === "website";
  const nameField = (
    <Field label={t.sourceName}>
      <Input
        required
        maxLength={200}
        value={draft.name}
        onChange={(e) => change({ name: e.target.value })}
      />
    </Field>
  );
  return (
    <div className="knowledge-workspace stack-gap">
      <header className="knowledge-heading">
        <div>
          <h1>{t.add}</h1>
          <p>{t.addHint}</p>
        </div>
        <AppLink
          className="text-link"
          href={`${shell.hrefOf("knowledge-import")}?profile=1`}
        >
          {t.editProfile}
        </AppLink>
      </header>
      <ol className="knowledge-steps" aria-label={t.progress}>
        {[t.stepContent, t.stepUse, t.result].map((label, i) => (
          <li key={label} aria-current={current === i ? "step" : undefined}>
            <span>{i + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      {mutation.error && !shownBelow && (
        <WorkspaceError code={mutation.error} t={t} />
      )}
      {linked.error && !built && step === "use" && (
        <WorkspaceError code={linked.error.message} t={t} />
      )}
      <section className="knowledge-form stack-gap">
        <h2 ref={heading} tabIndex={-1} className="knowledge-step-title">
          {titles[step]}
        </h2>
        {step === "what" && (
          <div className="knowledge-choices">
            {(
              [
                ["manual", t.whatManual, t.whatManualHint],
                ["file", t.whatFile, t.whatFileHint],
                ["website", t.whatSite, t.whatSiteHint],
                ["github", t.whatGithub, t.whatGithubHint],
              ] as const
            ).map(([kind, label, hint]) => (
              <Button
                key={kind}
                variant="outline"
                className="knowledge-choice"
                onClick={() => chooseKind(kind)}
              >
                <span>
                  <strong>{label}</strong>
                  <small>{hint}</small>
                </span>
                <ChevronRight aria-hidden="true" />
              </Button>
            ))}
          </div>
        )}
        {step === "content" && isSite && (
          <>
            <form className="stack-gap" onSubmit={discover}>
              {nameField}
              <Field label={t.url}>
                <Input
                  required
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="https://"
                  readOnly={Boolean(sourceId)}
                  value={draft.url ?? ""}
                  onChange={(e) => {
                    change({ url: e.target.value });
                    setSite(null);
                  }}
                />
              </Field>
              <div>
                <Button
                  type="submit"
                  variant={site ? "outline" : "default"}
                  disabled={busy}
                >
                  {busy ? t.findingPages : t.findPages}
                </Button>
              </div>
            </form>
            {site && (
              <SitePagePicker
                site={site}
                excluded={excluded}
                onChange={(next) => {
                  setExcluded(next);
                  dropPreview();
                }}
                disabled={busy}
                t={t}
              />
            )}
            {site && !selected.length && (
              <Alert kind="warning">{t.noPageSelected}</Alert>
            )}
            <div className="form-actions">
              <Button variant="outline" onClick={() => goBack("what")}>
                {t.back}
              </Button>
              {site && (
                <Button
                  disabled={busy || !selected.length || !draft.name.trim()}
                  onClick={() => enterUse()}
                >
                  {t.continue}
                </Button>
              )}
            </div>
          </>
        )}
        {step === "content" && !isSite && (
          <form
            className="stack-gap"
            onSubmit={(e) => {
              e.preventDefault();
              enterUse();
            }}
          >
            {nameField}
            {draft.kind === "github" ? (
              <GithubSource
                draft={draft}
                change={change}
                t={t}
                beforeConnect={persist}
              />
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
            <div className="form-actions">
              <Button
                type="button"
                variant="outline"
                onClick={() => goBack("what")}
              >
                {t.back}
              </Button>
              <Button type="submit" disabled={busy}>
                {t.continue}
              </Button>
            </div>
          </form>
        )}
        {step === "use" && (
          <>
            <WayPicker
              kind={draft.kind}
              text={draft.text}
              pages={pageCount}
              value={way}
              onChange={chooseWay}
              disabled={busy}
              t={t}
            />
            {!previewOnly && (
              <fieldset className="knowledge-usage">
                <legend>{t.usage}</legend>
                {(
                  [
                    ["marketing", t.marketing],
                    ["support", t.support],
                    ["modelUse", t.modelRead],
                    ["publicUse", t.publicUse],
                    ...(isSite && way === "whole"
                      ? ([["autoUpdate", t.weeklyUpdates]] as const)
                      : []),
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={rights[key]}
                      disabled={busy}
                      onChange={(e) =>
                        changeRights({ ...rights, [key]: e.target.checked })
                      }
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
            )}
            {noAudience && <Alert kind="warning">{t.noAudience}</Alert>}
            {way !== "whole" && !previewOnly && <p>{t.reviewRights}</p>}
            {way === "ai" && preview && (
              <SelectionSummary preview={preview} t={t} />
            )}
            {way === "ai" ? (
              <AnalysisStart
                check={check}
                busy={busy}
                startDisabled={noAudience}
                onStart={() => preview && startAnalysis(preview.id, true)}
                onRetry={() => {
                  if (!preview) {
                    void prepareAi();
                    return;
                  }
                  setChecked(null);
                  setCheckAttempt((n) => n + 1);
                }}
                onNewPreview={() => void prepareAi()}
                t={t}
              />
            ) : (
              <div>
                <Button
                  disabled={busy || noAudience}
                  onClick={
                    way === "statement"
                      ? submitStatement
                      : isSite
                        ? readSite
                        : takeOverContent
                  }
                >
                  {way === "statement"
                    ? t.submitStatement
                    : isSite
                      ? t.readPages.replace(
                          "{pages}",
                          pagesText(selected.length, locale),
                        )
                      : t.takeOver}
                </Button>
              </div>
            )}
            <div className="form-actions">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => goBack("content")}
              >
                {t.back}
              </Button>
            </div>
          </>
        )}
        {step === "result" && outcome && (
          <ResultStep
            outcome={outcome}
            run={
              outcome.kind === "analysis"
                ? data.runs.find((r) => r.id === outcome.runId)
                : outcome.kind === "site"
                  ? data.siteRuns?.find(
                      (r) => r.data.sourceId === outcome.sourceId,
                    )
                  : undefined
            }
            onNewPreview={() => {
              setOutcome(null);
              enterUse(true);
            }}
            refresh={refresh}
            t={t}
          />
        )}
      </section>
    </div>
  );
}

/** What exactly the analysis will read, before the owner starts it. */
function SelectionSummary({
  preview,
  t,
}: {
  preview: Preview;
  t: KnowledgeCopy;
}) {
  const { locale } = useWorkspace();
  return (
    <div className="stack-gap">
      {preview.partial && (
        <Alert kind="warning">
          {t.partial} {t.omitted}: {preview.skipped}
        </Alert>
      )}
      <details>
        <summary>
          {t.files}: {preview.files.length} · {t.characters}:{" "}
          {preview.characters.toLocaleString(locale)}
        </summary>
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
      </details>
    </div>
  );
}

export function ResultStep({
  outcome,
  run,
  onNewPreview,
  refresh,
  t,
}: {
  outcome: Outcome;
  /** The analysis run, or the latest read of the site source. */
  run: Entity | undefined;
  onNewPreview: () => void;
  refresh: () => void;
  t: KnowledgeCopy;
}) {
  const { project, locale } = useWorkspace();
  const shell = useShell();
  const mutation = useMutation();
  if (outcome.kind !== "analysis") {
    // The start's own sentence ends with the read; the run then speaks for itself.
    const ended = run && !siteRunActive(run.data.status);
    return (
      <>
        {outcome.kind === "site" && !outcome.started ? (
          <Alert>{t.siteAlreadyRunning}</Alert>
        ) : (
          !ended && (
            <Alert kind="success">
              {outcome.kind === "content"
                ? t.contentDone
                : t.siteStarted.replace(
                    "{pages}",
                    pagesText(outcome.pages, locale),
                  )}
            </Alert>
          )
        )}
        {outcome.kind === "site" &&
          (run ? (
            <SiteRunSummary run={run} t={t} />
          ) : (
            outcome.started && <p>{t.runningHint}</p>
          ))}
        <div>
          <AppLink
            className="button button-primary"
            href={`${shell.hrefOf("knowledge-sources")}?source=${outcome.sourceId}`}
          >
            {t.sourcesLink}
          </AppLink>
        </div>
      </>
    );
  }
  const status = String(run?.data.status ?? "queued");
  return (
    <>
      <p role="status">{workspaceStatus(status, t)}</p>
      {Boolean(run?.data.error) && (
        <WorkspaceError code={String(run?.data.error)} t={t} />
      )}
      {mutation.error && <WorkspaceError code={mutation.error} t={t} />}
      {status === "completed" && (
        <>
          {run?.data.proposalCount === 0 && <p>{t.noProposal}</p>}
          <div>
            <AppLink
              className="button button-primary"
              href={shell.hrefOf("knowledge-review")}
            >
              {t.reviewNow}
            </AppLink>
          </div>
        </>
      )}
      {analysisRunning(status) && <p>{t.runningHint}</p>}
      {run && analysisRunning(status) && (
        <div>
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
        </div>
      )}
      {run && ["failed", "canceled"].includes(status) && (
        <div>
          <Button variant="outline" onClick={onNewPreview}>
            {t.newPreview}
          </Button>
        </div>
      )}
    </>
  );
}
