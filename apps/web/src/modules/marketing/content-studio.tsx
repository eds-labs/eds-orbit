"use client";
import { Fragment, useState } from "react";
import { ArrowRight, ChevronDown, ChevronRight } from "lucide-react";
import { value, when, type Entity } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { fieldLabel } from "@/lib/field-text";
import { Badge, Button, Status } from "@/components/ui/primitives";
import { baseContentId } from "./approval-lists";
import { ChannelLabel, channelInfo, type ChannelEntry } from "./channel-names";
import { marketingText } from "./labels";

// Content Studio rows (WP3, 2026-11-10): one row per post with its channel
// versions inside (R76 copies carry `sharedFrom.contentId`), channel names
// instead of stored ids, and replaced versions behind a toggle.

/** A revision superseded it or the owner retried its run (draft-state.ts). */
export const replacedContent = (row: Entity) =>
  Boolean(row.data.supersededBy || row.data.retiredWithRunId);

export type ContentGroup = {
  baseId: string;
  /** The row the group is named after: the original when listed, else the first. */
  lead: Entity;
  /** Every listed version of the post, the original first. */
  variants: Entity[];
};

/** Groups content by its original, leaving replaced versions out unless asked. */
export function contentGroups(
  items: Entity[],
  options: { showReplaced?: boolean } = {},
): { groups: ContentGroup[]; replaced: number } {
  const replaced = items.filter(replacedContent).length;
  const shown = options.showReplaced
    ? items
    : items.filter((row) => !replacedContent(row));
  const byBase = new Map<string, Entity[]>();
  for (const row of shown) {
    const key = baseContentId(row);
    byBase.set(key, [...(byBase.get(key) ?? []), row]);
  }
  const groups = [...byBase.entries()].map(([baseId, rows]) => {
    const variants = [...rows].sort(
      (a, b) => Number(a.id !== baseId) - Number(b.id !== baseId),
    );
    return { baseId, lead: variants[0]!, variants };
  });
  return { groups, replaced };
}

/** The table of grouped content; a group with several channels expands. */
export function ContentGroupRows({
  groups,
  channels,
  locale,
  timezone,
  onSelect,
}: {
  groups: ContentGroup[];
  channels: ReadonlyMap<string, ChannelEntry>;
  locale: Locale;
  timezone: string;
  onSelect: (row: Entity) => void;
}) {
  const words = marketingText(locale).content;
  const [open, setOpen] = useState<string[]>([]);
  const typeLabel = (row: Entity) => {
    const type = String(row.data.type ?? "");
    return marketingText(locale).contentTypes[type] ?? (type || "—");
  };
  const title = (row: Entity) => value(row, "title", value(row, "body"));
  const latest = (rows: Entity[]) =>
    rows.reduce((a, b) => (String(b.updatedAt) > String(a.updatedAt) ? b : a))
      .updatedAt;
  const channel = (row: Entity) => (
    <ChannelLabel info={channelInfo(row.data.channel, channels, locale)} />
  );
  return (
    <div className="table-wrap">
      <table className="table-plain-head">
        <caption className="sr-only">{words.caption}</caption>
        <thead>
          <tr>
            <th scope="col">{fieldLabel(locale, "title")}</th>
            <th scope="col">{words.format}</th>
            <th scope="col">{words.channels}</th>
            <th scope="col">{fieldLabel(locale, "status")}</th>
            <th scope="col">{fieldLabel(locale, "updatedAt")}</th>
            <th scope="col">
              <span className="sr-only">{words.open("")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const many = group.variants.length > 1;
            const expanded = open.includes(group.baseId);
            const name = title(group.lead);
            return (
              <Fragment key={group.baseId}>
                <tr>
                  <td>
                    <button
                      className="row-button"
                      onClick={() => onSelect(group.lead)}
                    >
                      {name}
                    </button>
                    {replacedContent(group.lead) && (
                      <>
                        {" "}
                        <Badge tone="neutral">{words.replaced}</Badge>
                      </>
                    )}
                  </td>
                  <td>{typeLabel(group.lead)}</td>
                  <td>
                    {many ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="content-group-toggle"
                        aria-expanded={expanded}
                        aria-label={words.expand(name)}
                        onClick={() =>
                          setOpen((ids) =>
                            expanded
                              ? ids.filter((id) => id !== group.baseId)
                              : [...ids, group.baseId],
                          )
                        }
                      >
                        {expanded ? <ChevronDown /> : <ChevronRight />}
                        {words.variants(group.variants.length)}
                      </Button>
                    ) : (
                      channel(group.lead)
                    )}
                  </td>
                  <td>
                    {many ? (
                      <span className="approval-item-meta">
                        {group.variants.map((row) => (
                          <Status key={row.id} value={row.data.status} />
                        ))}
                      </span>
                    ) : (
                      <Status value={group.lead.data.status} />
                    )}
                  </td>
                  <td>{when(latest(group.variants), locale, timezone)}</td>
                  <td>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={words.open(name)}
                      onClick={() => onSelect(group.lead)}
                    >
                      <ArrowRight />
                    </Button>
                  </td>
                </tr>
                {many &&
                  expanded &&
                  group.variants.map((row) => (
                    <tr key={row.id} className="content-variant-row">
                      <td>
                        <button
                          className="row-button"
                          onClick={() => onSelect(row)}
                        >
                          {channel(row)}
                        </button>
                        {replacedContent(row) && (
                          <>
                            {" "}
                            <Badge tone="neutral">{words.replaced}</Badge>
                          </>
                        )}
                      </td>
                      <td>{typeLabel(row)}</td>
                      <td>{channel(row)}</td>
                      <td>
                        <Status value={row.data.status} />
                      </td>
                      <td>{when(row.updatedAt, locale, timezone)}</td>
                      <td>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={words.open(
                            `${name} · ${channelInfo(row.data.channel, channels, locale).label}`,
                          )}
                          onClick={() => onSelect(row)}
                        >
                          <ArrowRight />
                        </Button>
                      </td>
                    </tr>
                  ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
