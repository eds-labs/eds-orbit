import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

const answers = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    useResource: (path: string | null) => {
      const key = Object.keys(answers).find((part) => path?.includes(part));
      return {
        data: key === undefined ? null : answers[key],
        error: null,
        loading: false,
        refresh: () => {},
      };
    },
  };
});

import { renderToStaticMarkup } from "react-dom/server";
import type { Entity, Identity, Project } from "@/lib/api";
import { labels, type Locale } from "@/lib/i18n";
import { WorkspaceContext } from "@/components/workspace-context";
import { ShellContext, type ShellContextValue } from "@/platform/shell/shell-context";
import { BrandAssetLibrary } from "./advanced";
import { assetFacts, assetSource, inCategory, inStatus, sourceLabel } from "./asset-library-text";

const project = { id: "p1", workspaceId: "w1", name: "Synthetic", timezone: "Europe/Berlin", role: "owner" } as Project;
const identity: Identity = {
  user: { id: "u1", name: "Ada", email: "ada@example.invalid" },
  workspaces: [{ id: "w1", name: "Org", role: "owner" }],
  projects: [project],
};

function render({ locale = "en" as Locale, owner = true, studio = true } = {}) {
  const shell = { features: { creativeStudio: studio }, modules: [] } as unknown as ShellContextValue;
  return renderToStaticMarkup(
    <ShellContext.Provider value={shell}>
      <WorkspaceContext.Provider
        value={{
          project,
          identity,
          locale,
          t: (k) => labels[locale][k],
          canEdit: owner,
          isOwner: owner,
          revision: 0,
          refresh: () => {},
          href: (p) => p,
        }}
      >
        <BrandAssetLibrary />
      </WorkspaceContext.Provider>
    </ShellContext.Provider>,
  );
}

const ASSIGNMENT = "6766a12d-0000-4000-8000-000000000001";
const SHA = "a".repeat(64);
const entity = (id: string, data: Record<string, unknown>): Entity => ({
  id,
  workspaceId: "w1",
  projectId: "p1",
  kind: "assets",
  version: 1,
  data,
  createdAt: "2026-11-01T08:00:00.000Z",
  updatedAt: "2026-11-01T08:00:00.000Z",
});
const generated = entity("asset-generated-0001", {
  name: "Assignment banner background: FamilyPlan autumn family moments with a very long title that wraps",
  type: "generated_artwork",
  mime: "image/png",
  filename: "assignment-banner.png",
  width: 1536,
  height: 1024,
  bytes: 3277649,
  hasContent: true,
  source: "OpenAI Images API",
  provider: "openai",
  providerModel: "gpt-image-2.5",
  prompt: "Synthetic owner-only prompt text",
  sha256: SHA,
  profileVersion: 6,
  assignmentId: ASSIGNMENT,
  bannerBackground: true,
  assetStatus: "approved",
  usageApproved: true,
  providerUse: false,
  driveFileId: "1DriveFileIdSynthetic0001",
  driveFolderId: "1DriveFolderIdSynthetic01",
  driveSyncStatus: "SYNCED",
});
const upload = entity("asset-upload-0002", {
  name: "Team photo",
  type: "photo",
  mime: "image/png",
  bytes: 52_000,
  hasContent: true,
  source: "Studio Berlin",
  uploadedBy: "u1",
  assetStatus: "reference",
  usageApproved: false,
});
const failed = entity("asset-failed-0003", {
  name: "Spring banner",
  type: "generated_artwork",
  mime: "image/png",
  bytes: 900,
  hasContent: true,
  source: "template",
  sourceType: "TEMPLATE_GENERATED",
  assetStatus: "approved",
  usageApproved: true,
  driveSyncStatus: "FAILED",
});
const outdated = entity("asset-outdated-0004", {
  name: "Old uLiquid style background",
  type: "generated_artwork",
  mime: "image/png",
  hasContent: true,
  source: "OpenAI Images API",
  assetStatus: "outdated",
});
const bound = entity("asset-bound-0005", { name: "Bound banner", boundTo: { runId: "r1" }, assetStatus: "approved" });
answers["/assets"] = { items: [generated, upload, failed, outdated, bound] };

const withoutDetails = (html: string) => html.replace(/<details class="asset-tile-details">.*?<\/details>/gs, "");
const tileOf = (html: string, name: string) =>
  [...html.matchAll(/<article class="asset-card asset-tile">(.*?)<\/article>/gs)].find((m) => m[1]!.includes(name))?.[1] ??
  "";

describe("brand asset library tiles (WP4)", () => {
  it("shows readable facts instead of raw MIME types and byte counts", () => {
    const html = render();
    expect(html).toContain("PNG · 1536×1024 · 3.1 MB");
    expect(render({ locale: "de" })).toContain("PNG · 1536×1024 · 3,1 MB");
    expect(html).not.toMatch(/\d bytes|image\/png ·/);
    expect(html).toContain("PNG · 51 KB");
  });

  it("keeps raw ids, hashes and the model in the technical details only", () => {
    const html = render();
    // Links and the preview carry ids in their URLs, never as text.
    const visible = withoutDetails(html).replace(/<[^>]+>/g, " ");
    for (const raw of [generated.id, "1DriveFolderIdSynthetic01", "1DriveFileIdSynthetic0001", SHA, "gpt-image-2.5", ASSIGNMENT])
      expect(visible).not.toContain(raw);
    const tile = tileOf(html, "Assignment banner background");
    const details = tile.match(/<details class="asset-tile-details">(.*?)<\/details>/s)?.[1] ?? "";
    expect(details).toContain("<summary>Technical details</summary>");
    for (const raw of [generated.id, "1DriveFolderIdSynthetic01", SHA, "gpt-image-2.5", ASSIGNMENT, "generated_artwork"])
      expect(details).toContain(raw);
    expect(details).not.toMatch(/<details[^>]*\sopen/);
    expect(render({ locale: "de" })).toContain("<summary>Technische Details</summary>");
    expect(html).not.toContain("Drive folder:");
  });

  it("names source, status and Drive trouble in the reader's language", () => {
    const en = withoutDetails(render());
    expect(en).toContain("AI-generated (OpenAI)");
    expect(en).toContain("Upload · Studio Berlin");
    expect(en).toContain("Composed by Orbit");
    expect(en).toContain(">Approved<");
    expect(en).toContain(">Reference<");
    expect(en).toContain("Drive upload failed");
    expect(en).toContain("Banner background of an assignment");
    expect(en).not.toMatch(/OpenAI Images API|SYNCED|>generated artwork<|>approved</);
    const de = withoutDetails(render({ locale: "de" }));
    for (const text of ["KI-generiert (OpenAI)", ">Freigegeben<", ">Referenz<", "Drive-Upload fehlgeschlagen", "Banner-Hintergrund eines Auftrags"])
      expect(de).toContain(text);
    // A synced asset shows no Drive badge.
    expect(tileOf(render(), "Assignment banner background")).not.toMatch(/Drive upload failed|Saving to Drive/);
  });

  it("clamps a long name but keeps the full name in its title, with a lazy preview and alt text", () => {
    const tile = tileOf(render(), "Assignment banner background");
    expect(tile).toContain(`title="${generated.data.name}"`);
    expect(tile).toMatch(/<img[^>]*loading="lazy"/);
    expect(tile).toMatch(/<img[^>]*alt="Preview of Assignment banner background/);
  });

  it("hides outdated and bound assets by default and offers to show the outdated ones", () => {
    const html = render();
    expect(html).not.toContain("Old uLiquid style background");
    expect(html).not.toContain("Bound banner");
    expect(html).toContain("Show outdated (1)");
    expect(render({ locale: "de" })).toContain("Veraltete anzeigen (1)");
  });

  it("localizes the header, search, filters and view toggle", () => {
    const de = render({ locale: "de" });
    for (const text of [
      "Markenkit &amp; Medienbibliothek",
      "Asset hochladen",
      "Mit OpenAI erzeugen",
      'placeholder="Assets durchsuchen"',
      "Alle Kategorien",
      "Alle Status",
      "Alle Quellen",
      "Listenansicht",
    ])
      expect(de).toContain(text);
    const en = render();
    for (const text of ["Brand kit &amp; asset library", "Upload asset", "Generate with OpenAI", 'placeholder="Search assets"', "List view"])
      expect(en).toContain(text);
  });

  it("shows the prompt and the owner's actions to owners only", () => {
    const owner = render();
    expect(owner).toContain("Synthetic owner-only prompt text");
    expect(tileOf(owner, "Team photo")).toContain(">Approve rights &amp; use</button>");
    expect(tileOf(owner, "Team photo")).toContain(">Mark outdated</button>");
    expect(tileOf(owner, "Spring banner")).toContain(">Retry Drive upload</button>");
    expect(tileOf(render({ locale: "de" }), "Team photo")).toContain(">Freigeben</button>");
    expect(tileOf(render({ locale: "de" }), "Team photo")).toContain(">Als veraltet markieren</button>");
    const viewer = render({ owner: false });
    expect(viewer).not.toContain("Synthetic owner-only prompt text");
    expect(viewer).not.toMatch(/Approve rights|Mark outdated|Retry Drive upload|Upload asset/);
    // Download and Drive stay available to every member.
    const tile = tileOf(viewer, "Assignment banner background");
    expect(tile).toContain(">Download</a>");
    expect(tile).toContain(">Open in Drive</a>");
    expect(tile).toContain("May be sent to AI providers: no");
  });

  it("gives every action a 44 px target", () => {
    const html = render();
    expect(html).toMatch(/class="button button-outline"/);
    expect(html).not.toContain("button-sm");
  });
});

describe("asset library filters (WP4)", () => {
  const d = (asset: Entity) => asset.data;
  it("reads the source of every writer", () => {
    expect([generated, upload, failed].map((a) => assetSource(d(a)))).toEqual(["ai", "upload", "template"]);
    expect(assetSource({ source: "Google Drive", sourceType: "DRIVE_EXISTING" })).toBe("drive");
    expect(assetSource({ type: "original_logo" })).toBe("original");
    expect(assetSource({ sourceType: "AI_GENERATED", source: "OpenAI Images API" })).toBe("ai");
    expect(sourceLabel({ source: "Someone" }, false)).toBe("Someone");
  });

  it("filters by category and hides outdated assets unless asked", () => {
    expect([generated, upload].filter((a) => inCategory(d(a), "generated"))).toEqual([generated]);
    expect(inCategory({ type: "original_logo" }, "logos")).toBe(true);
    expect(inCategory({ type: "original_logo" }, "documents")).toBe(false);
    expect(inCategory({ mime: "application/pdf" }, "documents")).toBe(true);
    expect(inStatus(d(outdated), "all", false)).toBe(false);
    expect(inStatus(d(outdated), "all", true)).toBe(true);
    expect(inStatus(d(outdated), "outdated", false)).toBe(true);
    expect(inStatus(d(upload), "approved", false)).toBe(false);
  });

  it("leaves out dimensions and size it does not know", () => {
    expect(assetFacts({ mime: "image/webp" }, true)).toBe("WebP");
    expect(assetFacts({}, false)).toBe("");
    expect(assetFacts({ mime: "image/png", width: 800, height: 600, bytes: 512 }, false)).toBe("PNG · 800×600 · 512 B");
  });
});
