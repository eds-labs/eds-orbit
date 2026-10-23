"use client";
import { useState } from "react";
import { useResource } from "@/lib/api";
import { Skeleton } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { ResourceError } from "@/platform/ui/collection";
import { HomeCard } from "@/platform/ui/home-card";
import { financePath, query, type Summary } from "./api";
import { financeText } from "./labels";
import { periodRange } from "./overview";

/**
 * The finance card of the project home: how many receipts wait for review
 * and how many invoices are overdue. Renders nothing while the module
 * answers an error such as 404.
 */
export function FinanceHome() {
  const { project, locale } = useWorkspace();
  const shell = useShell();
  const t = financeText(locale);
  const [now] = useState(() => new Date());
  const summary = useResource<Summary>(
    financePath(project.id, `/summary${query(periodRange("12m", now))}`),
  );
  if (summary.error?.status === 404) return null;
  const s = summary.data;
  const count = (n: number | undefined) => (s ? String(n) : "—");
  return (
    <HomeCard
      id="home-card-finance"
      title={t.finance}
      href={shell.hrefOf("finance")}
    >
      {summary.loading ? (
        <Skeleton />
      ) : summary.error ? (
        <ResourceError error={summary.error} retry={summary.refresh} />
      ) : (
        <dl className="home-counts">
          <div>
            <dt>{t.dashboard.homeReview}</dt>
            <dd>{count(s?.reviewCount)}</dd>
          </div>
          <div data-tone={s && s.overdue.count > 0 ? "warning" : undefined}>
            <dt>{t.dashboard.homeOverdue}</dt>
            <dd>{count(s?.overdue.count)}</dd>
          </div>
        </dl>
      )}
    </HomeCard>
  );
}
