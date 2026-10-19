"use client";
import { useResource } from "@/lib/api";
import { Empty, Skeleton } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { ResourceError } from "@/platform/ui/collection";
import { HomeCard } from "@/platform/ui/home-card";
import { supportPath, type Summary, type Ticket } from "./api";
import { supportText } from "./labels";
import { TicketLink } from "./overview";

/**
 * The support card of the project home (UI restructure §5.2): open,
 * unassigned and SLA counts and the three most recently updated open
 * tickets. Renders nothing while the module answers 404.
 */
export function SupportHome() {
  const { project, locale } = useWorkspace();
  const shell = useShell();
  const t = supportText(locale);
  const summary = useResource<Summary>(supportPath(project.id, "/summary"));
  const tickets = useResource<{ items: Ticket[] }>(
    supportPath(project.id, "/tickets?openOnly=true&limit=3"),
  );
  if (summary.error?.status === 404) return null;
  const s = summary.data;
  const count = (n: number | undefined) => (s ? String(n) : "—");
  return (
    <HomeCard
      id="home-card-support"
      title={t.home.title}
      href={shell.hrefOf("support")}
      className="support-home"
    >
      {summary.loading ? (
        <Skeleton />
      ) : summary.error ? (
        <ResourceError error={summary.error} retry={summary.refresh} />
      ) : (
        <dl className="home-counts">
          <div>
            <dt>{t.home.open}</dt>
            <dd>{count(s?.open)}</dd>
          </div>
          <div>
            <dt>{t.home.unassigned}</dt>
            <dd>{count(s?.unassigned)}</dd>
          </div>
          <div data-tone={s && s.atRisk > 0 ? "warning" : undefined}>
            <dt>{t.home.atRisk}</dt>
            <dd>{count(s?.atRisk)}</dd>
          </div>
          <div data-tone={s && s.breached > 0 ? "critical" : undefined}>
            <dt>{t.home.breached}</dt>
            <dd>{count(s?.breached)}</dd>
          </div>
        </dl>
      )}
      <div className="home-card-list">
        <h3>{t.home.latest}</h3>
        {tickets.loading ? (
          <Skeleton />
        ) : tickets.error ? (
          <ResourceError error={tickets.error} retry={tickets.refresh} />
        ) : tickets.data?.items.length ? (
          <ul className="support-rows">
            {tickets.data.items.slice(0, 3).map((ticket) => (
              <TicketLink key={ticket.id} ticket={ticket} />
            ))}
          </ul>
        ) : (
          <Empty title={t.home.empty} />
        )}
      </div>
    </HomeCard>
  );
}
