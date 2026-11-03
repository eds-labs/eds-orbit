"use client";
import type { CalendarItem } from "../api";
import { socialText } from "../labels";
import { daySlots, type Slot } from "./grid";
import { PostChip } from "./month";

// The week (S6): a time column and seven days of half hours in the project's
// zone. Rows are the union of the seven days' slots: 50 in the week the
// clocks go back (the repeated hour marked "2nd"); in the week they go
// forward the skipped half hours exist on the other days only.

type Row = { key: string; label: string; repeated: boolean };

export function weekRows(
  days: string[],
  timeZone: string,
): { rows: Row[]; slots: Map<string, Slot>[] } {
  const slots = days.map(
    (date) =>
      new Map(
        daySlots(date, timeZone).map((s) => [
          `${s.label}|${s.repeated ? 2 : 1}`,
          s,
        ]),
      ),
  );
  const keys = new Set(slots.flatMap((m) => [...m.keys()]));
  const rows = [...keys].sort().map((key) => ({
    key,
    label: key.slice(0, 5),
    repeated: key.endsWith("|2"),
  }));
  return { rows, slots };
}

export function WeekGrid({
  label,
  days,
  bySlot,
  timeZone,
  locale,
  showProject,
  onOpen,
  handleOf,
  renderSlot = (_slot, children) => children,
}: {
  label: string;
  days: string[];
  bySlot: Map<string, CalendarItem[]>;
  timeZone: string;
  locale: "en" | "de";
  showProject: boolean;
  onOpen: (item: CalendarItem) => void;
  handleOf?: (item: CalendarItem) => React.ReactNode;
  /** Wraps a slot's content (the drop target in Task 5). */
  renderSlot?: (slot: Slot, children: React.ReactNode) => React.ReactNode;
}) {
  const t = socialText(locale).calendar;
  const { rows, slots } = weekRows(days, timeZone);
  return (
    <div className="cal-week-scroll">
      <table className="cal-week" aria-label={label}>
        <thead>
          <tr>
            <th scope="col">{t.time}</th>
            {days.map((date, i) => (
              <th key={date} scope="col" abbr={`${t.weekdays[i]} ${date}`}>
                {t.weekdaysShort[i]} {date.slice(8)}.{date.slice(5, 7)}.
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} data-slot={row.key}>
              <th scope="row">
                {row.repeated ? t.repeated(row.label) : row.label}
              </th>
              {days.map((date, i) => {
                const slot = slots[i]!.get(row.key);
                if (!slot)
                  return (
                    <td
                      key={date}
                      className="cal-slot cal-slot-missing"
                      aria-disabled="true"
                    />
                  );
                const items = bySlot.get(slot.at) ?? [];
                return (
                  <td key={date} className="cal-slot" data-at={slot.at}>
                    {renderSlot(
                      slot,
                      items.map((item) => (
                        <PostChip
                          key={item.id}
                          item={item}
                          timeZone={timeZone}
                          locale={locale}
                          showProject={showProject}
                          onOpen={onOpen}
                          handle={handleOf?.(item)}
                        />
                      )),
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
