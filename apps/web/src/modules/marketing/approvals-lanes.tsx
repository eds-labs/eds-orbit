"use client";
import type { ReactNode } from "react";
import { value, when, type Entity } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Status } from "@/components/ui/primitives";
import { AppLink } from "@/platform/ui/app-link";
import { platformName } from "@/platform/ui/platform-mark";
import { groupByBase, type LaneItem } from "./approval-lists";
import { ChannelLabel, channelInfo, type ChannelEntry } from "./channel-names";
import { marketingText } from "./labels";

// The lanes of the approvals page (WP3, 2026-11-10). Presentational only:
// the page (work.tsx ApprovalInbox) reads the data, sorts it with
// approvalLanes() and opens a content row's detail.

const DONE = ["canceled", "failed"];

/** The live publication or Postiz draft of a released row (newest first). */
export function liveHandoff(item: LaneItem): {
  publication: Entity | null;
  postizDraft: Entity | null;
} {
  const live = (rows: Entity[]) =>
    rows.find((row) => !DONE.includes(String(row.data.status))) ?? null;
  return {
    publication: live(item.publications),
    postizDraft: live(item.postizDrafts),
  };
}

/**
 * The status a lane shows for a row: what happens to a released post (a
 * publication waiting for its slot reads as scheduled), published or
 * replaced in the history, else the content's own status.
 */
export function laneStatus(item: LaneItem): string {
  if (item.lane === "released") {
    const { publication, postizDraft } = liveHandoff(item);
    const status = String(
      publication?.data.status ?? postizDraft?.data.status ?? "",
    );
    return status === "intent_created" ? "scheduled" : status || "scheduled";
  }
  if (item.lane === "history") {
    if (item.content.data.supersededBy || item.content.data.retiredWithRunId)
      return "replaced";
    if (
      item.publications.some((p) =>
        ["published", "published_test"].includes(String(p.data.status)),
      )
    )
      return "published";
  }
  return String(item.content.data.status ?? "");
}

/** The slot of a released row: its publication's, else its Postiz draft's. */
export function releaseSlot(item: LaneItem): string | null {
  const { publication, postizDraft } = liveHandoff(item);
  const at =
    publication?.data.scheduledAt ??
    postizDraft?.data.slotAt ??
    postizDraft?.data.remoteDate;
  return typeof at === "string" ? at : null;
}

/**
 * Who released a row and how it goes out, in words: the owner's release
 * (by you, or by an owner), the review agent's after the veto window, a
 * post announced in Social, or a Postiz draft hand-off.
 */
export function releaseNote(
  item: LaneItem,
  ctx: { userId: string; locale: Locale; timezone: string },
): string[] {
  const words = marketingText(ctx.locale).approvals;
  const { publication, postizDraft } = liveHandoff(item);
  const notes: string[] = [];
  if (publication) {
    const p = publication.data;
    const at =
      typeof p.ownerReleasedAt === "string"
        ? when(p.ownerReleasedAt, ctx.locale, ctx.timezone)
        : null;
    if (at)
      notes.push(
        p.ownerReleasedBy === ctx.userId
          ? words.releasedByYou(at)
          : words.releasedByOwner(at),
      );
    else if (typeof p.vetoDeadline === "string")
      notes.push(words.releasedByAgent);
    else notes.push(words.scheduled);
    if (typeof p.socialPostId === "string" && p.status === "intent_created")
      notes.push(words.heldInSocial);
  } else if (postizDraft) {
    notes.push(words.postizDraft);
  }
  return notes;
}

/**
 * A channel in words for accessible names ("@familyplan · Instagram"), so
 * the same control on two channel rows ("Stop", "Open in Social") is told
 * apart by a screen reader.
 */
export function channelWords(
  channel: unknown,
  channels: ReadonlyMap<string, ChannelEntry>,
  locale: Locale,
): string {
  const info = channelInfo(channel, channels, locale);
  const platform = platformName(info.platform);
  return platform && platform !== info.label
    ? `${info.label} · ${platform}`
    : info.label;
}

/** One lane: a section with a heading, or a collapsed one (details) with its count. */
export function Lane({
  id,
  title,
  count,
  intro,
  collapsible = false,
  open = false,
  children,
}: {
  id: string;
  title: string;
  count: number;
  intro: string;
  collapsible?: boolean;
  /** Collapsible lanes start closed unless this is set. */
  open?: boolean;
  children: ReactNode;
}) {
  const heading = (
    <h2 id={`${id}-title`}>
      {title}
      <span className="lane-count">({count})</span>
    </h2>
  );
  if (collapsible)
    return (
      <details
        className="panel approval-lane approval-list"
        aria-labelledby={`${id}-title`}
        open={open || undefined}
      >
        <summary>{heading}</summary>
        <p className="panel-note">{intro}</p>
        {children}
      </details>
    );
  return (
    <section
      className="approval-lane approval-list"
      aria-labelledby={`${id}-title`}
    >
      <div className="panel-head">
        <div>
          {heading}
          <p>{intro}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

/**
 * Content rows of a lane, one item per original with its channel versions
 * (each with its status); the title opens the original's detail. `note`
 * adds words to a version, `focus` marks the version of one publication.
 */
export function ContentLaneList({
  items,
  channels,
  locale,
  timezone,
  onSelect,
  note,
  link,
  focus,
  controls,
}: {
  items: LaneItem[];
  channels: ReadonlyMap<string, ChannelEntry>;
  locale: Locale;
  timezone: string;
  onSelect: (row: Entity) => void;
  note?: (item: LaneItem) => string[];
  /** A link beside a version (the Social post of a released one). */
  link?: (item: LaneItem) => { href: string; label: string } | null;
  /** The publication id opened from Social (`?publication=`), if any. */
  focus?: string | null;
  /** Actions beside a version (Stop of a released post), given the channel in words. */
  controls?: (item: LaneItem, channel: string) => ReactNode;
}) {
  return (
    <>
      {groupByBase(items).map((group) => {
        const lead = group.items[0]!.content;
        const focused = (item: LaneItem) =>
          Boolean(focus && item.publications.some((p) => p.id === focus));
        return (
          <article
            key={group.baseId}
            className={`approval-item approval-content-item${group.items.some(focused) ? " is-focused" : ""}`}
          >
            <p className="approval-item-meta">
              <button className="row-button" onClick={() => onSelect(lead)}>
                {value(lead, "title", value(lead, "body"))}
              </button>
            </p>
            <ul className="approval-variants">
              {group.items.map((item) => {
                const target = link?.(item) ?? null;
                const slot = note ? releaseSlot(item) : null;
                const channel = channelWords(
                  item.content.data.channel,
                  channels,
                  locale,
                );
                return (
                  <li
                    key={item.content.id}
                    className="approval-variant"
                    id={
                      focused(item) && focus
                        ? `publication-${focus}`
                        : undefined
                    }
                  >
                    <ChannelLabel
                      info={channelInfo(
                        item.content.data.channel,
                        channels,
                        locale,
                      )}
                    />
                    <Status value={laneStatus(item)} />
                    {slot && (
                      <span className="field-hint">
                        {marketingText(locale).approvals.slot(
                          when(slot, locale, timezone),
                        )}
                      </span>
                    )}
                    {(note?.(item) ?? []).map((text) => (
                      <span key={text} className="field-hint">
                        {text}
                      </span>
                    ))}
                    {target && (
                      <AppLink
                        className="text-link"
                        href={target.href}
                        aria-label={`${target.label} – ${channel}`}
                      >
                        {target.label}
                      </AppLink>
                    )}
                    {controls && (
                      <div className="approval-variant-controls">
                        {controls(item, channel)}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </article>
        );
      })}
    </>
  );
}
