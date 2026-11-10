"use client";
import { collectionPath, useResource } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { useWorkspace } from "@/components/workspace-context";
import {
  PlatformMark,
  platformKey,
  platformName,
} from "@/platform/ui/platform-mark";

// Channel names for content rows (WP3, 2026-11-10): content stores a
// Postiz integration id or `social:<accountId>`; people see the channel's
// name and platform. An id nobody can name reads as "Unnamed channel"; the
// id itself only appears as a technical detail (title attribute).

/** One row of GET /projects/:projectId/marketing/channels. */
export type ChannelEntry = {
  id: string;
  name: string | null;
  platform: string | null;
  source: "postiz" | "social";
  active: boolean;
};

export type ChannelInfo = {
  /** What to show: the channel's name, its platform, or "Unnamed channel". */
  label: string;
  platform: string | null;
  /** Whether the directory (or the platform word itself) named it. */
  known: boolean;
  /** The stored reference, for a title attribute only. */
  id: string;
};

const UNNAMED: Record<Locale, string> = {
  en: "Unnamed channel",
  de: "Kanal ohne Namen",
};

/** How a stored channel reference reads, from the channel list. */
export function channelInfo(
  id: unknown,
  directory: ReadonlyMap<string, ChannelEntry>,
  locale: Locale,
): ChannelInfo {
  const ref = typeof id === "string" ? id : "";
  if (!ref) return { label: "—", platform: null, known: false, id: "" };
  const entry = directory.get(ref);
  if (entry) {
    const platform = platformKey(entry.platform) ?? entry.platform;
    return {
      label: entry.name || platformName(entry.platform) || UNNAMED[locale],
      platform,
      known: true,
      id: ref,
    };
  }
  // Older content names the platform itself ("linkedin").
  if (platformKey(ref) === ref.toLowerCase())
    return {
      label: platformName(ref)!,
      platform: platformKey(ref),
      known: true,
      id: ref,
    };
  return { label: UNNAMED[locale], platform: null, known: false, id: ref };
}

/** The project's channel list by reference; empty while it loads or fails. */
export function useChannelDirectory(): ReadonlyMap<string, ChannelEntry> {
  const { project } = useWorkspace();
  const channels = useResource<{ items: ChannelEntry[] }>(
    collectionPath(project.id, "marketing/channels"),
  );
  return new Map((channels.data?.items ?? []).map((c) => [c.id, c]));
}

/** A channel's mark, name and (when the name is not the platform) its platform. */
export function ChannelLabel({ info }: { info: ChannelInfo }) {
  const platform = platformName(info.platform);
  return (
    <span
      className="channel-label"
      title={info.known ? undefined : info.id || undefined}
    >
      <PlatformMark platform={info.platform} />
      <span>
        {info.label}
        {platform && platform !== info.label ? ` · ${platform}` : ""}
      </span>
    </span>
  );
}
