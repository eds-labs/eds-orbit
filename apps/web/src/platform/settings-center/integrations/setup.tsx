"use client";
import Link from "next/link";
import { useContext } from "react";
import { RefreshCw } from "lucide-react";
import { useResource } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Badge, Button, Empty } from "@/components/ui/primitives";
import { ShellContext } from "@/platform/shell/shell-context";
import { integrationSectionId } from "../registry";
import { centerText } from "../texts";
import type { SectionProps } from "../types";
import {
  setupLinks,
  setupOffers,
  setupRole,
  setupSteps,
  type SetupStep,
  type SetupStepId,
  type SetupWho,
} from "./steps";
import { integrationPaths } from "./paths";
import { NOTE_TEXT } from "./provider-card";
import {
  gate,
  manageHrefOf,
  manageNote,
  organizationRecords,
  projectRecords,
  systemRecords,
  type AdminConnection,
} from "./scopes";
import { integrationText, type IntegrationTextKey } from "./texts";
import type {
  CatalogEntry,
  IntegrationState,
  ManageNote,
  OrganizationIntegrations,
  ProjectIntegrationsAnswer,
} from "./types";

// The guided setup (ADR 0027, phase 3): a step list per provider that says
// what is done and whose step is next, with one link to the section that
// edits the entry. It mounts no form: every setting has one canonical place
// (the connections section, the Drive section or a module's section; owner
// decision of 2026-11-11). Roles here are display hints only.

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

/** Where the entry is edited: a section address, else why there is none. */
export type SetupAction = { href: string | null; note: ManageNote | null };

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
  action,
  onRefresh,
}: {
  entry: CatalogEntry;
  steps: readonly SetupStep[];
  locale: Locale;
  /** The one link below the steps to the section that edits the entry. */
  action: SetupAction;
  /** Re-requests the records the steps are built from. */
  onRefresh?: () => void;
}) {
  const text = integrationText(locale);
  const label = labelOf(entry, locale);
  const current = steps.findIndex((s) => s.observable && !s.done);
  return (
    <section className="integration-setup">
      <h3>{label}</h3>
      <ol className="setup-steps" aria-label={text("setupTitle")}>
        {steps.map((s, index) => {
          const stepLabel = text(STEP_LABEL[s.id]);
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
                <strong>{stepLabel}</strong>
                {others ? null : <span className="setup-step-who">{who}</span>}
              </span>
              <span className="setup-step-status">
                <Badge tone={tone}>{status}</Badge>
                {s.href ? (
                  <Link href={s.href} aria-label={`${text("openStep")}: ${stepLabel}`}>
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
      {action.href !== null ? (
        <div className="integration-setup-action">
          <Button asChild variant="outline">
            <Link href={action.href} aria-label={`${text("manage")}: ${label}`}>
              {text("manage")}
            </Link>
          </Button>
        </div>
      ) : action.note !== null && Object.hasOwn(NOTE_TEXT, action.note) ? (
        <p className="integration-setup-action">{text(NOTE_TEXT[action.note])}</p>
      ) : null}
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

type CatalogAnswer = { items: CatalogEntry[] };
/** The admin list also says how many grants a connection has. */
type SystemConnection = AdminConnection & { activeGrants?: number };

const statesOf = (
  records: ReadonlyMap<string, ReadonlyArray<{ state: IntegrationState }>>,
  id: string,
) => (records.get(id) ?? []).map((r) => r.state);

/** The section that edits the entry in the scope, or why there is none. */
function actionOf(
  entry: CatalogEntry,
  ctx: Parameters<typeof manageHrefOf>[1],
): SetupAction {
  return { href: manageHrefOf(entry, ctx), note: manageNote(entry, ctx) };
}

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
      action={actionOf(entry, { scope, hrefOf, moduleSections: [], connectorProviders: [] })}
    />
  );
}

export function OrganizationSetup({ scope, id, locale, hrefOf, caps }: SectionProps) {
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
      action={actionOf(entry, { scope, hrefOf, moduleSections: [], connectorProviders: [] })}
    />
  );
}

export function ProjectSetup({ scope, id, locale, hrefOf, caps }: SectionProps) {
  const paths = integrationPaths(scope);
  const catalog = useResource<CatalogAnswer>(paths.catalog);
  const records = useResource<ProjectIntegrationsAnswer>(paths.records);
  const shell = useContext(ShellContext);
  const moduleSections = (shell?.integrations ?? []).map((c) => ({
    id: integrationSectionId(c),
    providers: c.providers,
  }));
  const connectorProviders = (shell?.connectors?.providers ?? []).map((p) => p.id);
  const waiting = gate([catalog, records]);
  if (waiting) return waiting;
  // Never an entry the member cannot use in the project (hidden or off
  // module, owner-only state): its address reads as not available.
  const offers = setupOffers(catalog.data!.items, "project", records.data!.unavailable ?? []);
  if (id === undefined) return <OfferList offers={offers} locale={locale} hrefOf={hrefOf} />;
  const entry = offers.find((e) => e.id === id);
  if (!entry) return <NotAvailable locale={locale} />;
  const own = records.data!.items.filter((i) => i.provider === entry.id);
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
      onRefresh={records.refresh}
      action={actionOf(entry, { scope, hrefOf, moduleSections, connectorProviders })}
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
