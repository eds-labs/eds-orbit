"use client";
import { useState } from "react";
import { useResource } from "@/lib/api";
import { Button } from "@/components/ui/primitives";
import { ResourceError } from "@/platform/ui/collection";
import {
  socialPath,
  type CalendarItem,
  type PostList,
  type PostListItem,
} from "../api";
import { socialText } from "../labels";
import { PostChip } from "./month";
import type { CalendarState } from "./query";

// The list view (S6): the project's posts with the calendar's filters, 50 at
// a time with "Load more". In the organization scope it lists the posts of
// the period the calendar read (see CalendarList).

/** A list row as a calendar item; the drawer loads origin and read-only. */
const asItem = (item: PostListItem, projectId: string): CalendarItem => ({
  ...item,
  projectId,
  origin: "manual",
  readOnly: false,
  publications: { total: 0, published: 0, failed: 0, unknown: 0, test: false },
});

function listQuery(state: CalendarState, cursor: string) {
  const out = new URLSearchParams({ limit: "50" });
  if (state.statuses.length) out.set("status", state.statuses.join(","));
  if (state.accountIds.length)
    out.set("accountIds", state.accountIds.join(","));
  if (state.platforms.length) out.set("platforms", state.platforms.join(","));
  if (state.origins.length) out.set("origins", state.origins.join(","));
  if (cursor) out.set("cursor", cursor);
  return out.toString();
}

function ListPage({
  projectId,
  state,
  cursor,
  first,
  last,
  timeZone,
  locale,
  onOpen,
  onMore,
}: {
  projectId: string;
  state: CalendarState;
  cursor: string;
  first: boolean;
  last: boolean;
  timeZone: string;
  locale: "en" | "de";
  onOpen: (item: CalendarItem) => void;
  onMore: (cursor: string) => void;
}) {
  const t = socialText(locale).calendar;
  const page = useResource<PostList>(
    socialPath(projectId, `/posts?${listQuery(state, cursor)}`),
  );
  if (page.error)
    return (
      <li>
        <ResourceError error={page.error} retry={page.refresh} />
      </li>
    );
  if (!page.data) return null;
  return (
    <>
      {first && !page.data.items.length && (
        <li className="field-hint">{t.emptyList}</li>
      )}
      {page.data.items.map((item) => (
        <li key={item.id}>
          <PostChip
            item={asItem(item, projectId)}
            timeZone={timeZone}
            locale={locale}
            showProject={false}
            onOpen={onOpen}
          />
        </li>
      ))}
      {last && page.data.nextCursor && (
        <li className="cal-list-more">
          <Button
            variant="outline"
            onClick={() => onMore(page.data!.nextCursor!)}
          >
            {t.loadMore}
          </Button>
        </li>
      )}
    </>
  );
}

/** The project's posts, paged. Keyed by the filters, so a new filter starts again. */
export function PostListPages(props: {
  projectId: string;
  state: CalendarState;
  timeZone: string;
  locale: "en" | "de";
  onOpen: (item: CalendarItem) => void;
}) {
  const [cursors, setCursors] = useState<string[]>([""]);
  return (
    <ul className="cal-list">
      {cursors.map((cursor, i) => (
        <ListPage
          key={cursor || "first"}
          {...props}
          cursor={cursor}
          first={i === 0}
          last={i === cursors.length - 1}
          onMore={(next) =>
            setCursors((all) => (all.includes(next) ? all : [...all, next]))
          }
        />
      ))}
    </ul>
  );
}

/** Calendar items as a list (the organization scope's list view). */
export function CalendarList({
  items,
  timeZone,
  locale,
  onOpen,
}: {
  items: CalendarItem[];
  timeZone: string;
  locale: "en" | "de";
  onOpen: (item: CalendarItem) => void;
}) {
  const t = socialText(locale).calendar;
  if (!items.length) return <p className="field-hint">{t.emptyList}</p>;
  return (
    <ul className="cal-list">
      {items.map((item) => (
        <li key={`${item.projectId}:${item.id}`}>
          <PostChip
            item={item}
            timeZone={timeZone}
            locale={locale}
            showProject
            onOpen={onOpen}
          />
        </li>
      ))}
    </ul>
  );
}
