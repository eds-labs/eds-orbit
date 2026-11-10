import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceContext } from "@/components/workspace-context";
import type { Entity } from "@/lib/api";
import { ContentGroupRows, contentGroups } from "./content-studio";
import { channelInfo, ChannelLabel, type ChannelEntry } from "./channel-names";
import {
  PlatformMark,
  platformKey,
  platformName,
} from "@/platform/ui/platform-mark";

const FB = "social:11111111-1111-4111-8111-111111111111";
const IG = "social:22222222-2222-4222-8222-222222222222";
const GONE = "social:33333333-3333-4333-8333-333333333333";
const row = (
  id: string,
  data: Record<string, unknown>,
  updatedAt = "2026-11-09T08:00:00.000Z",
) =>
  ({
    id,
    version: 1,
    kind: "content",
    workspaceId: "w",
    projectId: "p",
    createdAt: updatedAt,
    updatedAt,
    data: { type: "social", ...data },
  }) as Entity;
const directory = new Map<string, ChannelEntry>([
  [
    FB,
    {
      id: FB,
      name: "FamilyPlan",
      platform: "facebook",
      source: "social",
      active: true,
    },
  ],
  [
    IG,
    {
      id: IG,
      name: "@familyplan.app",
      platform: "instagram",
      source: "social",
      active: true,
    },
  ],
  [
    "postiz-li",
    {
      id: "postiz-li",
      name: "EDS Labs",
      platform: "linkedin-page",
      source: "postiz",
      active: true,
    },
  ],
]);

describe("Content Studio groups (WP3)", () => {
  const items = [
    row(
      "ig",
      {
        title: "Familienabend",
        channel: IG,
        status: "reviewed",
        sharedFrom: { contentId: "fb" },
      },
      "2026-11-09T09:00:00.000Z",
    ),
    row("fb", { title: "Familienabend", channel: FB, status: "reviewed" }),
    row("old", {
      title: "Familienabend v1",
      channel: FB,
      status: "needs_review",
      supersededBy: "fb",
    }),
    row("li", {
      title: "Release notes",
      channel: "postiz-li",
      status: "draft",
    }),
    row("lost", { title: "Old account", channel: GONE, status: "draft" }),
  ];

  it("groups channel copies with their original and hides replaced versions", () => {
    const { groups, replaced } = contentGroups(items);
    expect(replaced).toBe(1);
    expect(groups.map((g) => [g.baseId, g.variants.map((v) => v.id)])).toEqual([
      ["fb", ["fb", "ig"]],
      ["li", ["li"]],
      ["lost", ["lost"]],
    ]);
    expect(groups[0]!.lead.id).toBe("fb");
    const all = contentGroups(items, { showReplaced: true });
    expect(all.groups.map((g) => g.baseId)).toEqual([
      "fb",
      "old",
      "li",
      "lost",
    ]);
  });

  it("names channels by name and platform, never by their stored id", () => {
    const html = renderToStaticMarkup(
      <WorkspaceContext.Provider value={{ locale: "de" } as never}>
        <ContentGroupRows
          groups={contentGroups(items).groups}
          channels={directory}
          locale="de"
          timezone="Europe/Berlin"
          onSelect={() => {}}
        />
      </WorkspaceContext.Provider>,
    );
    // The pair is one row with its channel count; it expands.
    expect(html.match(/>Familienabend</g)).toHaveLength(1);
    expect(html).toContain("2 Kanäle");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Kanäle von Familienabend anzeigen");
    // Both variant statuses stay visible on the group row.
    expect(html.match(/Geprüft/g)?.length).toBe(2);
    // A Postiz channel by name with its platform and mark.
    expect(html).toContain("EDS Labs · LinkedIn");
    expect(html).toContain(
      'class="platform-mark platform-mark-linkedin" aria-hidden="true"',
    );
    // An unknown account: a readable fallback, the id only as a title.
    expect(html).toContain("Kanal ohne Namen");
    expect(html).toContain(`title="${GONE}"`);
    expect(html).not.toMatch(new RegExp(`>${GONE}<`));
    expect(html).not.toContain(">postiz-li<");
    // German headers, no "Updated At".
    expect(html).toContain(">Titel<");
    expect(html).toContain(">Kanäle<");
    expect(html).toContain(">Aktualisiert<");
    expect(html).not.toContain("Updated At");
  });

  it("reads every kind of channel reference", () => {
    expect(channelInfo(FB, directory, "en")).toEqual({
      label: "FamilyPlan",
      platform: "facebook",
      known: true,
      id: FB,
    });
    expect(channelInfo("postiz-li", directory, "en").platform).toBe("linkedin");
    expect(channelInfo("linkedin", directory, "en")).toMatchObject({
      label: "LinkedIn",
      known: true,
    });
    expect(channelInfo(GONE, directory, "en")).toEqual({
      label: "Unnamed channel",
      platform: null,
      known: false,
      id: GONE,
    });
    expect(channelInfo(undefined, directory, "de").label).toBe("—");
    const nameless = new Map([[IG, { ...directory.get(IG)!, name: null }]]);
    expect(channelInfo(IG, nameless, "de").label).toBe("Instagram");
    // The label names the platform once, not twice.
    expect(
      renderToStaticMarkup(
        <ChannelLabel info={channelInfo(IG, nameless, "de")} />,
      ),
    ).not.toContain("Instagram · Instagram");
  });

  it("knows the platforms by Social name and Postiz identifier", () => {
    expect(platformKey("instagram-standalone")).toBe("instagram");
    expect(platformKey("linkedin-page")).toBe("linkedin");
    expect(platformKey("X")).toBe("x");
    expect(platformKey("unknown-network")).toBeNull();
    expect(platformName("facebook")).toBe("Facebook");
    expect(renderToStaticMarkup(<PlatformMark platform="nothing" />)).toBe("");
    expect(renderToStaticMarkup(<PlatformMark platform="telegram" />)).toBe(
      '<span class="platform-mark platform-mark-telegram" aria-hidden="true">TG</span>',
    );
  });
});
