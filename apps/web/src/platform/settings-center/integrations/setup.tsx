"use client";
import Link from "next/link";
import { useContext, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { collectionPath, useResource, type Entity } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Button, Empty } from "@/components/ui/primitives";
import { GrantedConnections } from "@/components/granted-connections";
import { useWorkspace } from "@/components/workspace-context";
import { Integrations } from "@/platform/administration/admin-area";
import { ConnectionsPanel } from "@/platform/administration/connections-ui";
import { ShellContext } from "@/platform/shell/shell-context";
import { integrationSectionId } from "../registry";
import { manageHref } from "../routes";
import { centerText } from "../texts";
import type {
  ManageScope,
  ManagementCapabilities,
  ScopeKind,
  SectionProps,
} from "../types";
import { setupOffers } from "./catalog";
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

export { setupOffers };

export type SetupStepId = "choose" | "configure" | "check" | "authorize" | "assign" | "validate";
export type SetupWho = "admin" | "owner" | "projectOwner" | "anyone";
export type SetupStep = {
  id: SetupStepId;
  who: SetupWho;
  done: boolean;
  mine: boolean;
  href: string | null;
  /**
   * Whether this scope can see the step's result. A step that is not
   * observable is never done and never current; it follows in the project.
   */
  observable: boolean;
};
type SetupRole = { admin: boolean; organizationOwner: boolean; projectOwner: boolean };

export function setupSteps(input: {
  scope: ScopeKind;
  entry: CatalogEntry;
  role: SetupRole;
  /** States of the provider's records as the server sent them, in the current scope. */
  states: readonly IntegrationState[];
  granted: boolean;
  bound: boolean;
  /** Project scope: a record of this provider with scope "project" exists; else false. */
  projectStored: boolean;
  links: { organization: string | null; project: string | null };
}): SetupStep[] {
  const { scope, entry, role, states, granted, bound, projectStored, links } = input;
  const central = storageOf(entry).includes("central");
  // A project runs a project-only entry, or its own record of an entry with
  // both storages, without anything from the organization (ledger P3-R22).
  const ownRecord = scope === "project" && (!central || projectStored);
  const configureWho: SetupWho =
    scope === "system" ? "admin" : ownRecord ? "projectOwner" : "owner";
  const covers = (who: SetupWho) =>
    who === "anyone" ||
    (who === "admin" && role.admin) ||
    (who === "owner" && role.organizationOwner) ||
    (who === "projectOwner" && (role.projectOwner || role.organizationOwner));
  const linkOf = (who: SetupWho) =>
    who === "owner" ? links.organization : who === "projectOwner" ? links.project : null;
  const step = (
    id: SetupStepId,
    who: SetupWho,
    done: boolean,
    observable = true,
  ): SetupStep => {
    const mine = covers(who);
    return {
      id,
      who,
      done: observable && done,
      mine,
      href: mine ? null : linkOf(who),
      observable,
    };
  };
  // A state newer than this build counts as set up, never as checked.
  const some = (...wanted: string[]) => states.some((s) => wanted.includes(s));
  // A system administrator does not see project bindings (by design), and an
  // organization sees bindings but not a project's final check.
  return [
    step("choose", "anyone", true),
    step("configure", configureWho, states.some((s) => s !== "not_set_up")),
    step("check", configureWho, some("verified", "ready")),
    ...(central && !ownRecord
      ? [step("authorize", scope === "system" ? "admin" : "owner", granted)]
      : []),
    step("assign", "projectOwner", bound, scope !== "system"),
    step("validate", "projectOwner", some("ready"), scope === "project"),
  ];
}

/**
 * Who the member is for the step list, from the capabilities answer: each
 * role by a capability only that role receives (apps/api management
 * capabilities). `system.connections` only system administrators;
 * `organization.connections` only owners of that organization;
 * `project.members` only project owners (an organization owner is owner of
 * every project of it), never editors or viewers. With ORBIT_ADMINISTRATION
 * off the server lists no organization at all, so an organization owner then
 * reads here as a project owner only.
 */
export function setupRole(
  scope: ManageScope,
  caps: ManagementCapabilities | null | undefined,
): SetupRole {
  if (!caps) return { admin: false, organizationOwner: false, projectOwner: false };
  const admin = caps.system.includes("system.connections");
  const ownsOrganization = (id: string) =>
    caps.organizations.some(
      (o) => o.id === id && o.capabilities.includes("organization.connections"),
    );
  switch (scope.kind) {
    case "organization":
      return { admin, organizationOwner: ownsOrganization(scope.organizationId), projectOwner: false };
    case "project": {
      const project = caps.projects.find((p) => p.id === scope.projectId);
      return {
        admin,
        organizationOwner: project ? ownsOrganization(project.workspaceId) : false,
        projectOwner: project?.capabilities.includes("project.members") ?? false,
      };
    }
    // No single organization or project is meant in the system scope.
    default:
      return { admin, organizationOwner: false, projectOwner: false };
  }
}

/**
 * Where another scope's steps are done. Only a project has one organization
 * to point to, and only when the member may open its setup; the member is
 * already in the project, and the system and an organization have no single
 * target. Today the organization link exists only when the member owns the
 * organization, whose steps are then their own; the "Open" link is for roles
 * that may open the organization without owning it.
 */
export function setupLinks(
  scope: ManageScope,
  entryId: string,
  caps: ManagementCapabilities | null | undefined,
): { organization: string | null; project: string | null } {
  if (scope.kind !== "project" || !caps) return { organization: null, project: null };
  const project = caps.projects.find((p) => p.id === scope.projectId);
  const organization = project
    ? caps.organizations.find(
        (o) =>
          o.id === project.workspaceId &&
          o.capabilities.includes("organization.connections"),
      )
    : undefined;
  return {
    organization: organization
      ? manageHref(
          { kind: "organization", organizationId: organization.id },
          "integrations",
          "setup",
          entryId,
        )
      : null,
    project: null,
  };
}

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
// A value of a newer API must not break the page.
const storageOf = (entry: CatalogEntry): readonly string[] =>
  Array.isArray(entry.storage) ? entry.storage : [];
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
      <ol aria-label={text("setupTitle")}>
        {steps.map((s, index) => {
          const label = text(STEP_LABEL[s.id]);
          const who = text(WHO_LABEL[s.who]);
          const others = s.observable && !s.done && !s.mine;
          return (
            <li key={s.id} aria-current={index === current ? "step" : undefined}>
              <strong>{label}</strong>
              {others ? null : <span> · {who}</span>}{" "}
              {!s.observable ? (
                <span>{text("stepInProject")}</span>
              ) : s.done ? (
                <span>{text("stepDone")}</span>
              ) : s.mine ? (
                <span>{text("stepYours")}</span>
              ) : (
                <span>
                  {text("stepOthers")} {who}
                  {s.href ? (
                    <>
                      {" "}
                      <Link href={s.href} aria-label={`${text("openStep")}: ${label}`}>
                        {text("openStep")}
                      </Link>
                    </>
                  ) : null}
                </span>
              )}
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
      {workbench}
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
