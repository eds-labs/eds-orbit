"use client";
import { useId, useState } from "react";
import Link from "next/link";
import type { AttentionItem } from "@/lib/api";
import { Badge, Button } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { renderAttention } from "./attention";
import { attentionWhen } from "./relative-time";
import { locate, projectHref, routeEnabled, type RouteTable } from "./routes";
import { useShell } from "./shell-context";

// The home page's list of attention items (UI restructure §5.1): one row per
// item with the module, the text its renderer gives, a due or age pill and
// one link to the page that resolves it.

/**
 * Where an item's `link` (a path below /p/:id, with an optional query) leads
 * in the open project, or null when no page of the route table matches it or
 * the page is not available to the member (ruling R22: the row stays, but
 * without a dead link), such as /approvals while marketing is off.
 */
export function attentionTarget(
  link: string,
  projectId: string,
  table: RouteTable,
  enabled: (moduleId: string) => boolean,
): string | null {
  const match = /^(\/[^?#]*)([?#].*)?$/.exec(link);
  if (!match) return null;
  const [, path, suffix = ""] = match;
  const place = locate(`/p/${encodeURIComponent(projectId)}${path}`, table);
  if (place.kind !== "view" && place.kind !== "redirect") return null;
  return routeEnabled(place.route, enabled)
    ? projectHref(projectId, place.route) + suffix
    : null;
}

function AttentionRow({ item, now }: { item: AttentionItem; now: Date }) {
  const { project, locale, t } = useWorkspace();
  const shell = useShell();
  const text = renderAttention(
    item,
    shell.attentionRenderers,
    locale,
    shell.modules,
  );
  const when = attentionWhen(item, now, locale);
  const href = attentionTarget(item.link, project.id, shell.table, (id) =>
    Boolean(shell.modules.find((m) => m.id === id)?.enabled),
  );
  const owner =
    item.moduleId === "platform"
      ? t("navProject")
      : (shell.modules.find((m) => m.id === item.moduleId)?.displayName[
          locale
        ] ?? item.moduleId);
  const urgent = item.severity === "critical";
  return (
    <li className="attention-row" data-severity={item.severity}>
      <span className="attention-chip" data-module={item.moduleId}>
        {owner}
      </span>
      <span className="attention-text">
        <strong className="attention-title">{text.title}</strong>
        {text.detail && <span className="attention-detail">{text.detail}</span>}
      </span>
      {when && (
        <span className="attention-when">
          <Badge
            tone={
              when.overdue || urgent
                ? "danger"
                : item.dueAt
                  ? "warning"
                  : "neutral"
            }
          >
            {when.text}
          </Badge>
        </span>
      )}
      {href && (
        <Button
          asChild
          size="sm"
          variant={urgent ? "default" : "outline"}
          className="attention-action"
        >
          <Link href={href}>
            {text.action[locale]}
            <span className="sr-only">{`: ${text.title}`}</span>
          </Link>
        </Button>
      )}
    </li>
  );
}

/**
 * The items in the order the API sorted them (by urgency), at most `max`
 * until "Show all" reveals the rest.
 */
export function AttentionList({
  items,
  max,
  now = new Date(),
  defaultExpanded = false,
}: {
  items: readonly AttentionItem[];
  max: number;
  /** The time the pills count from. */
  now?: Date;
  defaultExpanded?: boolean;
}) {
  const { t } = useWorkspace();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const listId = useId();
  const shown = expanded ? items : items.slice(0, max);
  return (
    <>
      <ul className="attention-list" id={listId}>
        {shown.map((item) => (
          <AttentionRow key={item.id} item={item} now={now} />
        ))}
      </ul>
      {items.length > max && (
        <button
          type="button"
          className="text-button attention-more"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? t("showFewer") : `${t("showAll")} (${items.length})`}
        </button>
      )}
    </>
  );
}
