"use client";
import { Badge } from "@/components/ui/primitives";
import type { CalendarItem } from "../api";
import { socialText } from "../labels";
import { localOf, type DayCell } from "./grid";

// The month grid (S6): whole weeks, up to three posts per day and "+N more",
// which opens that day's week.

const SHOWN = 3;

/** One post in a calendar cell: a button that opens the preview drawer. */
export function PostChip({
  item,
  timeZone,
  locale,
  showProject,
  onOpen,
}: {
  item: CalendarItem;
  timeZone: string;
  locale: "en" | "de";
  showProject: boolean;
  onOpen: (item: CalendarItem) => void;
}) {
  const all = socialText(locale);
  const t = all.calendar;
  const time = item.schedule.at
    ? localOf(item.schedule.at, timeZone).slice(11)
    : "";
  return (
    <button
      type="button"
      className={`cal-post cal-post-${item.status}`}
      data-post={item.id}
      onClick={() => onOpen(item)}
    >
      <span className="cal-post-time">{time}</span>{" "}
      <span className="cal-post-title">
        {item.title || item.excerpt || item.id}
      </span>{" "}
      <span className="cal-post-meta">
        {item.accounts.map((a) => (
          <span key={a.accountId} className="cal-platform">
            {all.platform[a.platform]}
          </span>
        ))}
        <Badge
          tone={
            item.status === "failed"
              ? "danger"
              : item.status === "published"
                ? "success"
                : "neutral"
          }
        >
          {all.posts.status[item.status]}
        </Badge>
        {item.publications.unknown > 0 && (
          <Badge tone="warning">{t.unknown}</Badge>
        )}
        {item.origin === "legacy_postiz" && <Badge>{t.legacy}</Badge>}
        {item.publications.test && <Badge>{t.test}</Badge>}
        {showProject && item.projectName && (
          <span className="cal-project">{item.projectName}</span>
        )}
      </span>
    </button>
  );
}

export function MonthGrid({
  label,
  cells,
  byDay,
  timeZone,
  locale,
  showProject,
  onOpen,
  onMore,
  renderDay = (_date, children) => children,
}: {
  label: string;
  cells: DayCell[];
  byDay: Map<string, CalendarItem[]>;
  timeZone: string;
  locale: "en" | "de";
  showProject: boolean;
  onOpen: (item: CalendarItem) => void;
  onMore: (date: string) => void;
  /** Wraps a day's content (the drop target in Task 5). */
  renderDay?: (date: string, children: React.ReactNode) => React.ReactNode;
}) {
  const t = socialText(locale).calendar;
  const weeks = Array.from({ length: cells.length / 7 }, (_, i) =>
    cells.slice(i * 7, i * 7 + 7),
  );
  return (
    <div className="cal-month-scroll">
      <table role="grid" className="cal-month" aria-label={label}>
        <thead>
          <tr>
            {t.weekdays.map((day, i) => (
              <th key={day} role="columnheader" scope="col" abbr={day}>
                {t.weekdaysShort[i]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]!.date}>
              {week.map((cell) => {
                const items = byDay.get(cell.date) ?? [];
                return (
                  <td
                    key={cell.date}
                    role="gridcell"
                    className={
                      cell.inMonth ? "cal-day" : "cal-day cal-day-outside"
                    }
                    aria-current={cell.isToday ? "date" : undefined}
                    data-date={cell.date}
                  >
                    {renderDay(
                      cell.date,
                      <>
                        <span className="cal-day-number">
                          {Number(cell.date.slice(8))}
                        </span>
                        {items.length > 0 && (
                          <ul className="cal-day-posts">
                            {items.slice(0, SHOWN).map((item) => (
                              <li key={item.id}>
                                <PostChip
                                  item={item}
                                  timeZone={timeZone}
                                  locale={locale}
                                  showProject={showProject}
                                  onOpen={onOpen}
                                />
                              </li>
                            ))}
                          </ul>
                        )}
                        {items.length > SHOWN && (
                          <button
                            type="button"
                            className="cal-more"
                            aria-label={t.moreLabel(
                              items.length - SHOWN,
                              cell.date,
                            )}
                            onClick={() => onMore(cell.date)}
                          >
                            {t.more(items.length - SHOWN)}
                          </button>
                        )}
                      </>,
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
