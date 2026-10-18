"use client";
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { useResource, when } from "@/lib/api";
import {
  Badge,
  Button,
  Empty,
  Input,
  Loading,
  Tabs,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { cn } from "@/lib/utils";
import {
  STATUSES,
  VIEWS,
  slaState,
  supportPath,
  ticketQuery,
  type Ticket,
} from "./api";
import { supportText } from "./labels";
import { SLA_TONE, TicketView } from "./ticket";
import { TagChip, useSupportLists, type TagDef } from "./tags";

/** The ticket opened in the URL (?ticket=), kept in sync without a reload. */
function useOpenTicket() {
  const [ticketId, setTicketId] = useState<string | null>(null);
  useEffect(() => {
    setTicketId(new URLSearchParams(window.location.search).get("ticket"));
  }, []);
  const open = (id: string | null) => {
    setTicketId(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("ticket", id);
    else url.searchParams.delete("ticket");
    window.history.replaceState(null, "", url);
  };
  return [ticketId, open] as const;
}

/** The support inbox: views, filters and search, with the open ticket. */
export function SupportInbox() {
  const { project, locale } = useWorkspace();
  const t = supportText(locale);
  const [view, setView] = useState<(typeof VIEWS)[number]>("all");
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [tag, setTag] = useState("");
  const lists = useSupportLists();
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [pages, setPages] = useState<Array<string | null>>([null]);
  const [ticketId, openTicket] = useOpenTicket();
  const [revision, setRevision] = useState(0);
  useEffect(() => setPages([null]), [view, status, category, tag, search]);
  return (
    <div className="support-page">
      <PageHead title={t.support} description={t.supportIntro} />
      <div className={cn("support-layout", ticketId && "support-layout-open")}>
        <section className="support-list" aria-label={t.tickets}>
          <Tabs
            tabs={VIEWS.map((v) => ({ key: v, label: t.views[v] }))}
            value={view}
            onChange={(v) => setView(v as typeof view)}
          />
          <form
            className="support-filters"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(q);
            }}
          >
            <label className="support-search">
              <Search aria-hidden size={16} />
              <Input
                aria-label={t.search}
                placeholder={t.search}
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
            <select
              aria-label={t.statusLabel}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">{t.anyStatus}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t.status[s]}
                </option>
              ))}
            </select>
            {lists.categories.length > 0 && (
              <select
                aria-label={t.category}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">{t.anyCategory}</option>
                {lists.categories.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
            {lists.tags.length > 0 && (
              <select
                aria-label={t.tags}
                value={tag}
                onChange={(e) => setTag(e.target.value)}
              >
                <option value="">{t.anyTag}</option>
                {lists.tags.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </select>
            )}
          </form>
          {pages.map((cursor, i) => (
            <TicketPage
              key={`${revision}-${cursor ?? "first"}`}
              path={supportPath(
                project.id,
                `/tickets?${ticketQuery({ view, status, category, tag, q: search, cursor })}`,
              )}
              tagDefs={lists.tags}
              selected={ticketId}
              onOpen={openTicket}
              onMore={
                i === pages.length - 1
                  ? (next) => setPages([...pages, next])
                  : undefined
              }
            />
          ))}
        </section>
        {ticketId && (
          <section className="support-detail">
            <TicketView
              ticketId={ticketId}
              onBack={() => openTicket(null)}
              onChanged={() => setRevision((n) => n + 1)}
            />
          </section>
        )}
      </div>
    </div>
  );
}

function TicketPage({
  path,
  tagDefs,
  selected,
  onOpen,
  onMore,
}: {
  path: string;
  tagDefs: TagDef[];
  selected: string | null;
  onOpen: (id: string) => void;
  onMore?: (cursor: string) => void;
}) {
  const { locale, project } = useWorkspace();
  const t = supportText(locale);
  const page = useResource<{ items: Ticket[]; nextCursor: string | null }>(
    path,
  );
  if (page.loading) return <Loading />;
  if (page.error)
    return <ResourceError error={page.error} retry={page.refresh} />;
  const items = page.data?.items ?? [];
  if (!items.length && !onMore) return null;
  if (!items.length) return <Empty title={t.noTickets} />;
  return (
    <>
      <ul className="support-rows">
        {items.map((ticket) => {
          const sla = slaState(ticket);
          return (
            <li key={ticket.id}>
              <button
                type="button"
                className={cn(
                  "support-row",
                  selected === ticket.id && "support-row-active",
                )}
                aria-current={selected === ticket.id ? "true" : undefined}
                onClick={() => onOpen(ticket.id)}
              >
                <span className="support-row-title">
                  #{ticket.number} {ticket.subject}
                </span>
                <span className="support-row-meta">
                  {ticket.contact?.name ?? ticket.contact?.email ?? "—"} ·{" "}
                  {when(ticket.updatedAt, locale, project.timezone)}
                </span>
                <span className="support-row-badges">
                  <Badge>
                    {t.status[ticket.status as keyof typeof t.status]}
                  </Badge>
                  {sla !== "ok" && sla !== "done" && (
                    <Badge tone={SLA_TONE[sla]}>{t.sla[sla]}</Badge>
                  )}
                  {ticket.tags.map((tag) => (
                    <TagChip key={tag} tag={tag} defs={tagDefs} />
                  ))}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {onMore && page.data?.nextCursor && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onMore(page.data!.nextCursor!)}
        >
          {t.loadMore}
        </Button>
      )}
    </>
  );
}
