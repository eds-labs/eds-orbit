"use client";
import { useContext, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useResource } from "@/lib/api";
import { Badge, Button, Empty } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { ShellContext } from "@/platform/shell/shell-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import {
  cmsPath,
  type CalendarAnswer,
  type CalendarItem,
  type SiteList,
} from "./api";
import { cmsText } from "./labels";

// The content calendar (ADR 0029 §5, CH1.14e): schedules and publications of
// one month, grouped by day in the project's time zone.

const TONE: Record<
  CalendarItem["kind"],
  "blue" | "success" | "neutral" | "warning"
> = {
  scheduled: "blue",
  published: "success",
  updated: "success",
  unpublished: "warning",
};

/** The calendar day (yyyy-mm-dd) of an instant in a time zone. */
export function dayIn(instant: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * The request range of a month: a day around it on both sides, so every zone
 * is covered; the view keeps the days of the month itself.
 */
export function monthRange(year: number, month: number) {
  const from = new Date(Date.UTC(year, month, 1) - 86_400_000);
  const to = new Date(Date.UTC(year, month + 1, 1) + 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Items of one month by day, days in order. */
export function byDay(
  items: CalendarItem[],
  year: number,
  month: number,
  timeZone: string,
) {
  const prefix = `${year}-${String(month + 1).padStart(2, "0")}-`;
  const days = new Map<string, CalendarItem[]>();
  for (const item of items) {
    const day = dayIn(item.at, timeZone);
    if (!day.startsWith(prefix)) continue;
    days.set(day, [...(days.get(day) ?? []), item]);
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function CalendarView() {
  const { project, locale } = useWorkspace();
  const t = cmsText(locale);
  const c = t.calendar;
  const shell = useContext(ShellContext);
  const entriesHref = shell?.hrefOf("cms.entries") ?? "";
  const now = new Date();
  const [month, setMonth] = useState({
    year: now.getFullYear(),
    month: now.getMonth(),
  });
  const zone = project.timezone || "UTC";
  const range = monthRange(month.year, month.month);
  const answer = useResource<CalendarAnswer>(
    cmsPath(
      project.id,
      `/calendar?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
    ),
  );
  const sites = useResource<SiteList>(cmsPath(project.id, "/sites"));
  const siteNames = (ids: string[]) =>
    ids
      .map((id) => sites.data?.items.find((s) => s.id === id)?.name ?? id)
      .join(", ");
  const shift = (delta: number) =>
    setMonth(({ year, month: m }) => {
      const next = new Date(year, m + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  const title = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
  }).format(new Date(month.year, month.month, 1));
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: zone,
  });
  const dayTitle = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  const days = answer.data
    ? byDay(answer.data.items, month.year, month.month, zone)
    : [];
  return (
    <div className="support-page">
      <PageHead title={c.title} description={c.intro} />
      <div className="cms-calendar-head">
        <Button
          variant="outline"
          size="icon"
          aria-label={c.previous}
          onClick={() => shift(-1)}
        >
          <ChevronLeft />
        </Button>
        <h2 aria-live="polite">{title}</h2>
        <Button
          variant="outline"
          size="icon"
          aria-label={c.next}
          onClick={() => shift(1)}
        >
          <ChevronRight />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            setMonth({ year: now.getFullYear(), month: now.getMonth() })
          }
        >
          {c.today}
        </Button>
        <span className="field-hint">{c.zone(zone)}</span>
      </div>
      <ResourceError error={answer.error} retry={answer.refresh} />
      {answer.data &&
        (days.length ? (
          <ol className="cms-calendar">
            {days.map(([day, items]) => (
              <li key={day} className="cms-calendar-day">
                <h3>{dayTitle.format(new Date(`${day}T12:00:00Z`))}</h3>
                <ul>
                  {items.map((item) => (
                    <li
                      key={`${item.entryId}:${item.kind}:${item.at}`}
                      className="cms-calendar-item"
                    >
                      <span className="cms-calendar-time">
                        {time.format(new Date(item.at))}
                      </span>
                      <Badge tone={TONE[item.kind]}>{c.kinds[item.kind]}</Badge>
                      <a href={`${entriesHref}?entry=${item.entryId}`}>
                        {item.title || t.entries.untitled}
                      </a>
                      <span className="field-hint">
                        {item.locale}
                        {item.siteIds.length
                          ? ` · ${siteNames(item.siteIds)}`
                          : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        ) : (
          <Empty title={c.empty} />
        ))}
    </div>
  );
}
