"use client";
import Link from "next/link";
import { useContext, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { collectionPath, useResource, type Entity } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Badge, Button, Empty } from "@/components/ui/primitives";
import { GrantedConnections } from "@/components/granted-connections";
import { useWorkspace } from "@/components/workspace-context";
import { Integrations } from "@/platform/administration/admin-area";
import { ConnectionsPanel } from "@/platform/administration/connections-ui";
import { ShellContext } from "@/platform/shell/shell-context";
import { integrationSectionId } from "../registry";
import { centerText } from "../texts";
import type {
  ManageScope,
  ManagementCapabilities,
  ScopeKind,
  SectionProps,
} from "../types";
import {
  setupLinks,
  setupOffers,
  setupRole,
  setupSteps,
  storageOf,
  type SetupStep,
  type SetupStepId,
  type SetupWho,
} from "./steps";
import { integrationPaths } from "./paths";
import {
  gate,
  manageHrefOf,
  organizationRecords,
  projectRecords,
  systemRecords,
  type AdminConnection,
} from "./scopes";
import { integrationText, type IntegrationTextKey } from "./texts";
import type {
  CatalogEntry,
  IntegrationState,
  OrganizationIntegrations,
  ProjectIntegration,
} from "./types";

// The guided setup (ADR 0027, phase 3): a step list per provider that says
// what is done and whose step is next, above the existing connection panels.
// It adds no write path: every write is the mounted panel's own form and the
// server's own check. Roles here are display hints only.

export {
  hasOwnStep,
  setupLinks,
  setupOffers,
  setupRole,
  setupSteps,
  type SetupRole,
  type SetupStep,
  type SetupStepId,
  type SetupWho,
} from "./steps";

const STEP_LABEL: Record<SetupStepId, IntegrationTextKey> = {
  choose: "stepChoose",
  configure: "stepConfigure",
  check: "stepCheck",
  authorize: "stepAuthorize",
  assign: "stepAssign",
  validate: "stepValidate",
};
const WHO_LABEL: Record<SetupWho, IntegrationTextKey> = {
  admin: "whoAdmin",
  owner: "whoOwner",
  projectOwner: "whoProjectOwner",
  anyone: "whoAnyone",
};
const labelOf = (entry: CatalogEntry, locale: Locale) =>
  entry.label?.[locale] || entry.label?.en || entry.id;

export function SetupStepsView({
  entry,
  steps,
  locale,
  workbench,
  onRefresh,
}: {
  entry: CatalogEntry;
  steps: readonly SetupStep[];
  locale: Locale;
  /** The existing panels, mounted once below the steps. */
  workbench: ReactNode;
  /** Re-requests the records the steps are built from. */
  onRefresh?: () => void;
}) {
  const text = integrationText(locale);
  const current = steps.findIndex((s) => s.observable && !s.done);
  return (
    <section className="integration-setup">
      <h2>{labelOf(entry, locale)}</h2>
      <ol className="setup-steps" aria-label={text("setupTitle")}>
        {steps.map((s, index) => {
          const label = text(STEP_LABEL[s.id]);
          const who = text(WHO_LABEL[s.who]);
          const others = s.observable && !s.done && !s.mine;
          // The status as words; the tone only supports them.
          const [tone, status] = !s.observable
            ? (["neutral", text("stepInProject")] as const)
            : s.done
              ? (["success", text("stepDone")] as const)
              : s.mine
                ? (["blue", text("stepYours")] as const)
                : (["neutral", `${text("stepOthers")} ${who}`] as const);
          return (
            <li key={s.id} aria-current={index === current ? "step" : undefined}>
              <span className="setup-step-text">
                <strong>{label}</strong>
                {others ? null : <span className="setup-step-who">{who}</span>}
              </span>
              <span className="setup-step-status">
                <Badge tone={tone}>{status}</Badge>
                {s.href ? (
                  <Link href={s.href} aria-label={`${text("openStep")}: ${label}`}>
                    {text("openStep")}
                  </Link>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
      {onRefresh ? (
        <Button variant="outline" size="sm" onClick={onRefresh}>
          <RefreshCw data-icon="inline-start" />
          {text("refreshState")}
        </Button>
      ) : null}
      <div className="integration-setup-workbench">{workbench}</div>
    </section>
  );
}

function NotAvailable({ locale }: { locale: Locale }) {
  const t = centerText(locale);
  return <Empty title={t("notPermittedTitle")} description={t("notPermittedBody")} />;
}

/** The offers as links to their setup; shown without an id. */
function OfferList({
  offers,
  locale,
  hrefOf,
}: {
  offers: readonly CatalogEntry[];
  locale: Locale;
  hrefOf: SectionProps["hrefOf"];
}) {
  const text = integrationText(locale);
  return (
    <>
      <p>{text("chooseProviderHint")}</p>
      <ul>
        {offers.map((entry) => (
          <li key={entry.id}>
            <Link href={hrefOf("integrations", "setup", entry.id)}>
              {labelOf(entry, locale)}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

/** One refresh of every resource the steps are built from; null is skipped. */
export function refreshAll(
  resources: ReadonlyArray<{ refresh(): void } | null>,
): () => void {
  return () => resources.forEach((r) => r?.refresh());
}

type CatalogAnswer = { items: CatalogEntry[] };
/** The admin list also says how many grants a connection has. */
type SystemConnection = AdminConnection & { activeGrants?: number };

const statesOf = (
  records: ReadonlyMap<string, ReadonlyArray<{ state: IntegrationState }>>,
  id: string,
) => (records.get(id) ?? []).map((r) => r.state);

export function SystemSetup({ scope, id, locale, hrefOf, caps }: SectionProps) {
  const paths = integrationPaths(scope);
  const catalog = useResource<CatalogAnswer>(paths.catalog);
  const connections = useResource<{ items: SystemConnection[] }>(paths.connections);
  const waiting = gate([catalog, connections]);
  if (waiting) return waiting;
  const offers = setupOffers(catalog.data!.items, "system");
  if (id === undefined) return <OfferList offers={offers} locale={locale} hrefOf={hrefOf} />;
  const entry = offers.find((e) => e.id === id);
  if (!entry) return <NotAvailable locale={locale} />;
  const items = connections.data!.items;
  return (
    <SetupStepsView
      entry={entry}
      steps={setupSteps({
        scope: "system",
        entry,
        role: setupRole(scope, caps),
        states: statesOf(systemRecords(items), entry.id),
        granted: items.some((c) => c.provider === entry.id && (c.activeGrants ?? 0) > 0),
        bound: false,
        projectStored: false,
        links: setupLinks(scope, entry.id, caps),
      })}
      locale={locale}
      onRefresh={connections.refresh}
      workbench={<Integrations locale={locale} provider={entry.id} />}
    />
  );
}

export function OrganizationSetup({ scope, id, locale, identity, hrefOf, caps }: SectionProps) {
  const paths = integrationPaths(scope);
  const catalog = useResource<CatalogAnswer>(paths.catalog);
  const usage = useResource<OrganizationIntegrations>(paths.records);
  const waiting = gate([catalog, usage]);
  if (waiting) return waiting;
  const offers = setupOffers(catalog.data!.items, "organization");
  if (id === undefined) return <OfferList offers={offers} locale={locale} hrefOf={hrefOf} />;
  const entry = offers.find((e) => e.id === id);
  if (!entry || scope.kind !== "organization") return <NotAvailable locale={locale} />;
  const own = (usage.data!.connections ?? []).filter((c) => c.provider === entry.id);
  const projects = identity.projects
    .filter((p) => p.workspaceId === scope.organizationId)
    .map((p) => ({ id: p.id, name: p.name }));
  return (
    <SetupStepsView
      entry={entry}
      steps={setupSteps({
        scope: "organization",
        entry,
        role: setupRole(scope, caps),
        states: statesOf(organizationRecords(usage.data!, locale), entry.id),
        granted: own.some((c) => (c.projects ?? []).length > 0),
        bound: own.some((c) => (c.projects ?? []).some((p) => p.bound)),
        projectStored: false,
        links: setupLinks(scope, entry.id, caps),
      })}
      locale={locale}
      onRefresh={usage.refresh}
      workbench={
        <ConnectionsPanel
          base={paths.connections!}
          mode="owner"
          locale={locale}
          targets={projects}
          provider={entry.id}
        />
      }
    />
  );
}

export function ProjectSetup({ scope, id, locale, hrefOf, caps }: SectionProps) {
  const paths = integrationPaths(scope);
  const { project, revision } = useWorkspace();
  const catalog = useResource<CatalogAnswer>(paths.catalog);
  const records = useResource<{ items: ProjectIntegration[] }>(paths.records);
  const offers = catalog.data ? setupOffers(catalog.data.items, "project") : [];
  const entry = id === undefined ? undefined : offers.find((e) => e.id === id);
  const central = entry ? storageOf(entry).includes("central") : false;
  // The Connectors page's own request: GrantedConnections shows a grant as
  // bound from it, and a bind refreshes the workspace revision.
  const connectors = useResource<{ items: Entity[] }>(
    central ? collectionPath(project.id, `connectors?revision=${revision}`) : null,
  );
  const shell = useContext(ShellContext);
  const moduleSections = (shell?.integrations ?? []).map((c) => ({
    id: integrationSectionId(c),
    providers: c.providers,
  }));
  const connectorProviders = (shell?.connectors?.providers ?? []).map((p) => p.id);
  const waiting = gate(central ? [catalog, records, connectors] : [catalog, records]);
  if (waiting) return waiting;
  if (id === undefined) return <OfferList offers={offers} locale={locale} hrefOf={hrefOf} />;
  if (!entry) return <NotAvailable locale={locale} />;
  const text = integrationText(locale);
  const own = records.data!.items.filter((i) => i.provider === entry.id);
  const manage = storageOf(entry).includes("project")
    ? manageHrefOf(entry, { scope, hrefOf, moduleSections, connectorProviders })
    : undefined;
  return (
    <SetupStepsView
      entry={entry}
      steps={setupSteps({
        scope: "project",
        entry,
        role: setupRole(scope, caps),
        states: statesOf(projectRecords(records.data!.items), entry.id),
        // A disabled or revoked grant does not count as authorized.
        granted: own.some((i) => i.scope === "central" && i.state !== "disabled"),
        bound: own.some((i) => i.state === "ready"),
        projectStored: own.some((i) => i.scope === "project"),
        links: setupLinks(scope, entry.id, caps),
      })}
      locale={locale}
      onRefresh={refreshAll([records, central ? connectors : null])}
      workbench={
        <>
          {central ? (
            <GrantedConnections
              connectors={connectors.data?.items ?? []}
              provider={entry.id}
            />
          ) : null}
          {manage === undefined ? null : manage === null ? (
            <p>{text("managedInModule")}</p>
          ) : (
            <Button asChild variant="outline">
              <Link href={manage}>{text("manage")}</Link>
            </Button>
          )}
        </>
      }
    />
  );
}

/** Label and description of the setup section in every scope. */
export const SETUP_SECTION = {
  label: { en: "Set up an integration", de: "Integration einrichten" },
  description: {
    en: "Step by step: connection, check, grants and assignment.",
    de: "Schritt für Schritt: Verbindung, Prüfung, Freigaben und Zuordnung.",
  },
} as const;
