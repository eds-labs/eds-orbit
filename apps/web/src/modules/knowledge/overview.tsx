"use client";
import { useMemo } from "react";
import {
  Activity,
  ArrowRight,
  Database,
  FlaskConical,
  Layers,
  Link2,
  ListChecks,
  Radar,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import {
  collectionPath,
  useResource,
  value,
  when,
  type ApiError,
  type Dashboard,
  type Entity,
} from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Alert, Badge, Empty, Skeleton } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import {
  PageHead,
  ResourceError,
  useCollection,
} from "@/platform/ui/collection";
import { Metric } from "@/platform/ui/metric";
import type { IndexGeneration } from "./index-management";

const HOUR = 3600_000;
/** A source counts as expiring this close to the end of its maximum age. */
const EXPIRING_HOURS = 48;
/** The schema default of `maxAgeHours` (packages/schemas source). */
const DEFAULT_MAX_AGE_HOURS = 168;
/** How many sources and conflicts the overview lists. */
const LIST_LIMIT = 6;

export type SourceExpiry = {
  expiresAt: Date | null;
  state: "fresh" | "expiring" | "stale";
};

/**
 * When a source's last successful sync stops counting as current: stale
 * without a sync or past `lastSuccessfulSyncAt + maxAgeHours` (the rule of
 * /knowledge-health `staleSources`), expiring within 48 h of that.
 */
export function sourceExpiry(
  source: { lastSuccessfulSyncAt?: unknown; maxAgeHours?: unknown },
  now: number,
): SourceExpiry {
  const synced =
    typeof source.lastSuccessfulSyncAt === "string"
      ? Date.parse(source.lastSuccessfulSyncAt)
      : Number.NaN;
  if (Number.isNaN(synced)) return { expiresAt: null, state: "stale" };
  const maxAge =
    typeof source.maxAgeHours === "number" && source.maxAgeHours > 0
      ? source.maxAgeHours
      : DEFAULT_MAX_AGE_HOURS;
  const expires = synced + maxAge * HOUR;
  return {
    expiresAt: new Date(expires),
    state:
      now > expires
        ? "stale"
        : expires - now <= EXPIRING_HOURS * HOUR
          ? "expiring"
          : "fresh",
  };
}

/** Sources with their expiry, the earliest first; never synced ones lead. */
export function byExpiry(sources: Entity[], now: number) {
  return sources
    .map((source) => ({ source, expiry: sourceExpiry(source.data, now) }))
    .sort(
      (a, b) =>
        (a.expiry.expiresAt?.getTime() ?? -Infinity) -
          (b.expiry.expiresAt?.getTime() ?? -Infinity) ||
        value(a.source, "name").localeCompare(value(b.source, "name")),
    );
}

const TEXT = {
  en: {
    verifiedFacts: "Verified facts",
    indexGeneration: "Index generation",
    ownersOnly: "Owners only",
    staleCount: "{n} stale",
    freshness: "Source freshness",
    freshnessEmpty: "No sources yet",
    freshnessHint: "Add a source to build your source of truth.",
    allSources: "All sources",
    state: { fresh: "Fresh", expiring: "Expiring", stale: "Stale" },
    expires: "Expires",
    expired: "Expired",
    neverSynced: "Never synced",
    indexQuality: "Index quality",
    noEvaluation: "No evaluation is recorded for the active generation.",
    noActive: "No active index generation.",
    recall: "Recall@10",
    mrr: "MRR",
    forbidden: "Forbidden hits",
    cases: "Cases",
    evaluatedAt: "Evaluated",
    passed: "Passed",
    failed: "Failed",
    openConflicts: "Open conflicts",
    conflictsEmpty: "No open conflicts",
    allConflicts: "All conflicts",
    diagnostics: "Diagnostics",
    healthHint: "Expired facts, missing evidence, failed imports",
    impactHint: "Content to review after knowledge changed",
    inspectorHint: "Test what retrieval returns for a question",
    separate: "Knowledge and generated content stay separate.",
    homeLink: "Open the knowledge overview",
  },
  de: {
    verifiedFacts: "Verifizierte Fakten",
    indexGeneration: "Index-Generation",
    ownersOnly: "Nur für Owner",
    staleCount: "{n} veraltet",
    freshness: "Aktualität der Quellen",
    freshnessEmpty: "Noch keine Quellen",
    freshnessHint: "Füge eine Quelle hinzu, um deine Wissensbasis aufzubauen.",
    allSources: "Alle Quellen",
    state: { fresh: "Aktuell", expiring: "Läuft ab", stale: "Veraltet" },
    expires: "Läuft ab",
    expired: "Abgelaufen",
    neverSynced: "Nie synchronisiert",
    indexQuality: "Indexqualität",
    noEvaluation: "Für die aktive Generation ist keine Bewertung gespeichert.",
    noActive: "Keine aktive Index-Generation.",
    recall: "Recall@10",
    mrr: "MRR",
    forbidden: "Verbotene Treffer",
    cases: "Fälle",
    evaluatedAt: "Bewertet",
    passed: "Bestanden",
    failed: "Nicht bestanden",
    openConflicts: "Offene Konflikte",
    conflictsEmpty: "Keine offenen Konflikte",
    allConflicts: "Alle Konflikte",
    diagnostics: "Diagnose",
    healthHint: "Abgelaufene Fakten, fehlende Belege, fehlgeschlagene Importe",
    impactHint: "Inhalte, die nach einer Wissensänderung zu prüfen sind",
    inspectorHint: "Prüfe, was der Abruf zu einer Frage liefert",
    separate: "Wissen und generierte Inhalte bleiben getrennt.",
    homeLink: "Wissensübersicht öffnen",
  },
} as const;
export const knowledgeText = (locale: Locale) => TEXT[locale];

const STATE_TONE = {
  fresh: "success",
  expiring: "warning",
  stale: "danger",
} as const;

type HealthData = {
  conflicts?: Entity[];
  staleSources?: Entity[];
  failedImports?: Entity[];
  expiredFacts?: Entity[];
};

/** An error worth showing: a 404 means the module is off, which shows nothing. */
const shown = (error: ApiError | null, ignore: number[] = [404]) =>
  error && !ignore.includes(error.status) ? error : null;

/**
 * The reads behind the knowledge overview and the home card, from existing
 * endpoints only: /knowledge-health, the sources collection, the exact
 * verified-fact count of /dashboard (ruling R13) and, for owners, /indexes
 * (403 and 404 count as "not known").
 */
export function useKnowledgeData() {
  const { project, revision, isOwner } = useWorkspace();
  const health = useResource<HealthData>(
    collectionPath(project.id, `knowledge-health?revision=${revision}`),
  );
  const sources = useCollection("sources");
  const dashboard = useResource<Dashboard>(
    collectionPath(project.id, `dashboard?revision=${revision}`),
  );
  const indexes = useResource<{ items: IndexGeneration[] }>(
    isOwner ? collectionPath(project.id, `indexes?revision=${revision}`) : null,
  );
  const listed = (sources.data?.items ?? []).filter(
    (source) => source.data.status !== "revoked",
  );
  return {
    health,
    sources,
    dashboard,
    indexes,
    /** The sources that still sync: revoked ones never get current again. */
    listed,
    verified: dashboard.data?.counts.verifiedFacts ?? null,
    conflicts: health.data?.conflicts ?? null,
    active: indexes.data
      ? (indexes.data.items.find((index) => index.state === "active") ?? null)
      : undefined,
    indexError: shown(indexes.error, [403, 404]),
  };
}

/** A number as text, "—" while unknown. */
export const figure = (n: unknown) => (typeof n === "number" ? String(n) : "—");
const percent = (n: unknown) =>
  typeof n === "number" ? `${Math.round(n * 100)}%` : "—";
const decimal = (n: unknown) => (typeof n === "number" ? n.toFixed(2) : "—");

type KnowledgeData = ReturnType<typeof useKnowledgeData>;

function FreshnessCard({ data, now }: { data: KnowledgeData; now: number }) {
  const { project, locale } = useWorkspace();
  const shell = useShell();
  const text = knowledgeText(locale);
  const rows = byExpiry(data.listed, now).slice(0, LIST_LIMIT);
  const error = shown(data.sources.error);
  return (
    <section className="panel" aria-label={text.freshness}>
      <div className="panel-head">
        <h2>{text.freshness}</h2>
        <AppLink className="text-link" href={shell.hrefOf("knowledge-sources")}>
          {text.allSources}
          <ArrowRight aria-hidden />
        </AppLink>
      </div>
      <div className="knowledge-overview-body">
        {data.sources.loading ? (
          <Skeleton />
        ) : error ? (
          <ResourceError error={error} retry={data.sources.refresh} />
        ) : rows.length ? (
          <ul className="knowledge-rows">
            {rows.map(({ source, expiry }) => (
              <li key={source.id} className="readiness-row">
                <Link2 aria-hidden />
                <span>
                  <strong>{value(source, "name")}</strong>
                  <small>
                    {value(source, "type")} ·{" "}
                    {expiry.expiresAt
                      ? `${expiry.state === "stale" ? text.expired : text.expires} ${when(expiry.expiresAt.toISOString(), locale, project.timezone)}`
                      : text.neverSynced}
                  </small>
                </span>
                <Badge tone={STATE_TONE[expiry.state]}>
                  {text.state[expiry.state]}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <Empty
            icon={Database}
            title={text.freshnessEmpty}
            description={text.freshnessHint}
          />
        )}
      </div>
    </section>
  );
}

function ConflictsCard({ data }: { data: KnowledgeData }) {
  const { locale } = useWorkspace();
  const shell = useShell();
  const text = knowledgeText(locale);
  const error = shown(data.health.error);
  const conflicts = (data.conflicts ?? []).slice(0, LIST_LIMIT);
  return (
    <section className="panel" aria-label={text.openConflicts}>
      <div className="panel-head">
        <h2>{text.openConflicts}</h2>
        <AppLink
          className="text-link"
          href={shell.hrefOf("knowledge-conflicts")}
        >
          {text.allConflicts}
          <ArrowRight aria-hidden />
        </AppLink>
      </div>
      <div className="knowledge-overview-body">
        {data.health.loading ? (
          <Skeleton />
        ) : error ? (
          <ResourceError error={error} retry={data.health.refresh} />
        ) : conflicts.length ? (
          <ul className="knowledge-rows">
            {conflicts.map((fact) => (
              <li key={fact.id} className="readiness-row">
                <TriangleAlert aria-hidden />
                <span>
                  <strong>{value(fact, "key")}</strong>
                </span>
                <Badge tone="danger">{value(fact, "status")}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon={ListChecks} title={text.conflictsEmpty} />
        )}
      </div>
    </section>
  );
}

/** Whether the owner-only index quality card has anything to show. */
const showsQuality = (data: KnowledgeData, isOwner: boolean) =>
  isOwner &&
  (data.indexes.loading ||
    Boolean(data.indexes.data) ||
    Boolean(data.indexError));

/** The active generation's evaluation (owners; hidden on 403 or 404). */
function IndexQualityCard({ data }: { data: KnowledgeData }) {
  const { project, locale } = useWorkspace();
  const text = knowledgeText(locale);
  const evaluation = data.active?.evaluation ?? null;
  return (
    <section className="panel" aria-label={text.indexQuality}>
      <div className="panel-head">
        <h2>{text.indexQuality}</h2>
        {typeof evaluation?.passed === "boolean" && (
          <Badge tone={evaluation.passed ? "success" : "danger"}>
            {evaluation.passed ? text.passed : text.failed}
          </Badge>
        )}
      </div>
      <div className="knowledge-overview-body">
        {data.indexes.loading ? (
          <Skeleton />
        ) : data.indexError ? (
          <ResourceError error={data.indexError} retry={data.indexes.refresh} />
        ) : !data.active ? (
          <p className="knowledge-note">{text.noActive}</p>
        ) : !evaluation ? (
          <p className="knowledge-note">{text.noEvaluation}</p>
        ) : (
          <dl className="detail-grid">
            <dt>{text.indexGeneration}</dt>
            <dd>{data.active.generation}</dd>
            <dt>{text.recall}</dt>
            <dd>{percent(evaluation.recallAt10)}</dd>
            <dt>{text.mrr}</dt>
            <dd>{decimal(evaluation.mrr)}</dd>
            <dt>{text.forbidden}</dt>
            <dd>{figure(evaluation.forbiddenHits)}</dd>
            <dt>{text.cases}</dt>
            <dd>{figure(evaluation.cases)}</dd>
            <dt>{text.evaluatedAt}</dt>
            <dd>{when(evaluation.executedAt, locale, project.timezone)}</dd>
          </dl>
        )}
      </div>
    </section>
  );
}

function DiagnosticsCard() {
  const { t, locale } = useWorkspace();
  const shell = useShell();
  const text = knowledgeText(locale);
  const links: Array<
    [key: string, icon: LucideIcon, label: string, hint: string]
  > = [
    ["knowledge-health", Activity, t("health"), text.healthHint],
    ["knowledge-impact", Radar, t("impact"), text.impactHint],
    ["knowledge-inspector", FlaskConical, t("inspector"), text.inspectorHint],
  ];
  return (
    <section className="panel" aria-label={text.diagnostics}>
      <div className="panel-head">
        <h2>{text.diagnostics}</h2>
      </div>
      <div className="knowledge-overview-body">
        <div className="knowledge-rows">
          {links.map(([key, Icon, label, hint]) => (
            <AppLink
              key={key}
              className="readiness-row"
              href={shell.hrefOf(key)}
            >
              <Icon aria-hidden />
              <span>
                <strong>{label}</strong>
                <small>{hint}</small>
              </span>
              <ArrowRight aria-hidden />
            </AppLink>
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * The root of the Knowledge module (UI restructure §5.3): four metrics,
 * source freshness, open conflicts, the index quality for owners and the
 * diagnostic pages. The sidebar replaces the former tab bar.
 */
export function KnowledgeOverview() {
  const { t, locale, isOwner } = useWorkspace();
  const text = knowledgeText(locale);
  const data = useKnowledgeData();
  // One instant per load of the sources, so the order holds between renders.
  const now = useMemo(() => Date.now(), [data.sources.data]);
  const stale = data.listed.filter(
    (source) => sourceExpiry(source.data, now).state === "stale",
  ).length;
  const quality = showsQuality(data, isOwner);
  return (
    <>
      <PageHead
        title={t("knowledge")}
        description={t("knowledgeHint")}
        eyebrow={t("moduleEyebrow")}
      />
      <ResourceError
        error={shown(data.dashboard.error)}
        retry={data.dashboard.refresh}
      />
      <div className="metrics-strip metrics-four">
        <Metric
          icon={Database}
          label={t("sources")}
          amount={data.sources.data ? String(data.listed.length) : "—"}
          detail={
            stale ? text.staleCount.replace("{n}", String(stale)) : undefined
          }
        />
        <Metric
          icon={ListChecks}
          label={text.verifiedFacts}
          amount={figure(data.verified)}
        />
        <Metric
          icon={TriangleAlert}
          label={t("conflicts")}
          amount={figure(data.conflicts?.length)}
        />
        <Metric
          icon={Layers}
          label={text.indexGeneration}
          amount={figure(data.active?.generation)}
          detail={isOwner ? undefined : text.ownersOnly}
        />
      </div>
      <div className="overview-columns">
        <FreshnessCard data={data} now={now} />
        <ConflictsCard data={data} />
      </div>
      <div
        className={
          quality ? "overview-columns" : "overview-columns knowledge-single"
        }
      >
        {quality && <IndexQualityCard data={data} />}
        <DiagnosticsCard />
      </div>
      <Alert>{text.separate}</Alert>
    </>
  );
}
