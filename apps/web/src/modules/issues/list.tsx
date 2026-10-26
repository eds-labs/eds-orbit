"use client";
import { useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";
import { useResource } from "@/lib/api";
import { Button, Empty, Input, Loading } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { cn } from "@/lib/utils";
import { ISSUE_STATUSES, ISSUE_TYPES, issuesPath, query, readParam, SEVERITIES, SOURCES, writeParam, type IssuePage } from "./api";
import { IssueDetailView } from "./detail";
import { issuesText } from "./labels";
import { IssueRow, ReportForm, useIssuesAccess, useIssuesLists } from "./shared";

// The issue list (plan §5): filters, search, sort and "load more", with the
// open issue beside it (?issue=<id>). Filters can come from links, such as
// ?severity=s1_critical from the dashboard or an attention item.

const SORTS = ["lastSeen", "reports", "severity", "created", "number"] as const;

export function useOpenIssue() {
  const [issueId, setIssueId] = useState<string | null>(null);
  useEffect(() => setIssueId(readParam("issue")), []);
  const open = (id: string | null) => {
    setIssueId(id);
    writeParam("issue", id);
  };
  return [issueId, open] as const;
}

export function IssueListView() {
  const { project, locale } = useWorkspace();
  const t = issuesText(locale);
  const access = useIssuesAccess();
  const lists = useIssuesLists();
  const [issueId, openIssue] = useOpenIssue();
  const [filters, setFilters] = useState({ status: "open", type: "", severity: "", component: "", source: "", hasTasks: "", sort: "lastSeen" });
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [pages, setPages] = useState<Array<string | null>>([null]);
  const [revision, setRevision] = useState(0);
  const [reporting, setReporting] = useState(false);
  useEffect(() => {
    const severity = readParam("severity");
    const status = readParam("status");
    const hasTasks = readParam("hasTasks");
    setFilters((f) => ({
      ...f,
      ...(severity && (SEVERITIES as readonly string[]).includes(severity) ? { severity } : {}),
      ...(status ? { status } : {}),
      ...(hasTasks === "true" ? { hasTasks } : {}),
    }));
  }, []);
  useEffect(() => setPages([null]), [filters, search]);
  const set = (key: keyof typeof filters) => (value: string) => setFilters((f) => ({ ...f, [key]: value }));
  return (
    <div className="support-page">
      <PageHead title={t.nav.list} description={t.intro}>
        {access.report && (
          <Button onClick={() => setReporting(true)}>
            <Plus aria-hidden /> {t.newReport}
          </Button>
        )}
      </PageHead>
      {reporting && (
        <ReportForm
          onClose={() => setReporting(false)}
          onDone={(result) => {
            setReporting(false);
            setRevision((n) => n + 1);
            openIssue(result.issueId);
          }}
        />
      )}
      <div className={cn("support-layout", issueId && "support-layout-open")}>
        <section className="support-list" aria-label={t.nav.list}>
          <form
            className="support-filters"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(q.trim());
            }}
          >
            <label className="support-search">
              <Search aria-hidden size={16} />
              <Input aria-label={t.search} placeholder={t.search} value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <select aria-label={t.fields.status} value={filters.status} onChange={(e) => set("status")(e.target.value)}>
              <option value="open">{t.open}</option>
              <option value="triage">{t.awaitingTriage}</option>
              <option value="all">{t.all}</option>
              {ISSUE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t.status[s]}
                </option>
              ))}
            </select>
            <select aria-label={t.fields.type} value={filters.type} onChange={(e) => set("type")(e.target.value)}>
              <option value="">{t.any}</option>
              {ISSUE_TYPES.map((v) => (
                <option key={v} value={v}>
                  {t.type[v]}
                </option>
              ))}
            </select>
            <select aria-label={t.fields.severity} value={filters.severity} onChange={(e) => set("severity")(e.target.value)}>
              <option value="">{t.any}</option>
              {SEVERITIES.map((v) => (
                <option key={v} value={v}>
                  {t.severity[v]}
                </option>
              ))}
            </select>
            {(lists.settings?.components.length ?? 0) > 0 && (
              <select aria-label={t.fields.components} value={filters.component} onChange={(e) => set("component")(e.target.value)}>
                <option value="">{t.any}</option>
                {lists.settings!.components.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label[locale]}
                  </option>
                ))}
              </select>
            )}
            <select aria-label={t.reports} value={filters.source} onChange={(e) => set("source")(e.target.value)}>
              <option value="">{t.any}</option>
              {SOURCES.map((v) => (
                <option key={v} value={v}>
                  {t.source[v]}
                </option>
              ))}
            </select>
            <select aria-label={t.sortBy} value={filters.sort} onChange={(e) => set("sort")(e.target.value)}>
              {SORTS.map((s) => (
                <option key={s} value={s}>
                  {t.sort[s]}
                </option>
              ))}
            </select>
          </form>
          {pages.map((cursor, i) => (
            <Page
              key={`${revision}-${cursor ?? "first"}`}
              path={issuesPath(project.id, `/list?${query({ ...filters, q: search, cursor })}`)}
              selected={issueId}
              onOpen={openIssue}
              filtered={Boolean(search || filters.type || filters.severity || filters.component || filters.source)}
              onMore={i === pages.length - 1 ? (next) => setPages([...pages, next]) : undefined}
            />
          ))}
        </section>
        {issueId && (
          <section className="support-detail">
            <IssueDetailView key={issueId} issueId={issueId} onBack={() => openIssue(null)} onChanged={() => setRevision((n) => n + 1)} onOpen={openIssue} />
          </section>
        )}
      </div>
    </div>
  );
}

function Page({
  path,
  selected,
  onOpen,
  onMore,
  filtered,
}: {
  path: string;
  selected: string | null;
  onOpen: (id: string) => void;
  onMore?: (cursor: string) => void;
  filtered: boolean;
}) {
  const { locale } = useWorkspace();
  const t = issuesText(locale);
  const page = useResource<IssuePage>(path);
  if (page.loading) return <Loading />;
  if (page.error) return <ResourceError error={page.error} retry={page.refresh} />;
  const items = page.data?.items ?? [];
  if (!items.length && !onMore) return null;
  if (!items.length) return <Empty title={filtered ? t.noIssuesFilter : t.noIssues} />;
  return (
    <>
      <ul className="support-rows">
        {items.map((issue) => (
          <IssueRow key={issue.id} issue={issue} counts={issue.counts} selected={selected === issue.id} onOpen={onOpen} />
        ))}
      </ul>
      {onMore && page.data?.nextCursor && (
        <Button variant="outline" size="sm" onClick={() => onMore(page.data!.nextCursor!)}>
          {t.loadMore}
        </Button>
      )}
    </>
  );
}
