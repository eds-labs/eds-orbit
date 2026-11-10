import { beforeEach, describe, expect, it, vi } from "vitest";

// A website draft reads one page: up to 1 MB of HTML (inline styles and
// scripts included, as on familyplan.cloud) and up to 100,000 characters
// of text, the same bounds as an uploaded file.

const fetched = vi.hoisted(() => ({
  html: "",
  options: null as unknown,
  pages: new Map<string, string | Error>(),
}));
vi.mock("../../../../../packages/knowledge/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../../../packages/knowledge/src/index.ts")>()),
  fetchApprovedDocument: vi.fn(async (url: string, options: unknown) => {
    fetched.options = options;
    const page = fetched.pages.get(url);
    if (page instanceof Error) throw page;
    return { bytes: Buffer.from(page ?? fetched.html), mimeType: "text/html", url: "https://example.invalid/" };
  }),
}));
import { knowledgeDraft } from "../../../../../packages/schemas/src/knowledge-workspace.ts";
import { snapshot } from "./workspace.ts";

const draft = {
  kind: "website" as const,
  name: "Website",
  url: "https://example.invalid/",
  text: "",
  paths: [],
  language: "de",
  modelUse: true,
  audience: "Families",
  description: "Family organizer",
};
const scope = { workspaceId: "w", projectId: "p", userId: "u", role: "owner" as const };

describe("website snapshot", () => {
  beforeEach(() => {
    fetched.options = null;
    fetched.pages.clear();
  });

  it("reads a page whose HTML exceeds 100 KB through inline scripts", async () => {
    fetched.html = `<html><head><style>${"x".repeat(150_000)}</style></head><body><h1>Wer macht heute was?</h1><p>Aufgaben und Belohnungen für die ganze Familie.</p></body></html>`;
    const snap = await snapshot(scope, draft as never);
    expect(fetched.options).toMatchObject({ maxBytes: 1_000_000 });
    expect(snap.files).toHaveLength(1);
    expect(snap.files[0]!.text).toContain("Aufgaben und Belohnungen");
    expect(snap.files[0]!.text).not.toContain("xxxx");
  });

  it("refuses a page with more than 100,000 characters of text", async () => {
    fetched.html = `<html><body><p>${"Wort ".repeat(25_000)}</p></body></html>`;
    await expect(snapshot(scope, draft as never)).rejects.toMatchObject({
      code: "DOCUMENT_TOO_LARGE",
    });
  });

  describe("site drafts", () => {
    const root = "https://example.invalid/docs";
    const page = (name: string) => `${root}/${name}`;
    const html = (text: string) => `<html><body><p>${text}</p></body></html>`;
    const site = (pages: string[]) =>
      knowledgeDraft.parse({ ...draft, paths: ["/"], url: root, pages });

    it("a site draft snapshots each selected page, at most 30", async () => {
      fetched.pages.set(page("a"), html("Kalender teilen"));
      fetched.pages.set(page("b"), html("Einkaufslisten planen"));
      const snap = await snapshot(scope, site([page("a"), page("b"), page("a")]));
      expect(fetched.options).toMatchObject({
        allowedOrigins: ["https://example.invalid"],
        allowedPaths: ["/docs"],
      });
      expect(snap.files.map((f) => [f.path, f.url])).toEqual([
        ["/docs/a", page("a")],
        ["/docs/b", page("b")],
      ]);
      expect(snap.files[0]!.text).toContain("Kalender teilen");
      expect(snap).toMatchObject({ commit: null, partial: false, skipped: 0 });
      const many = (n: number) =>
        Array.from({ length: n }, (_, i) => page(String(i)));
      expect(site(many(30)).pages).toHaveLength(30);
      expect(() => site(many(31))).toThrow();
    });

    it("refuses more than 100,000 characters", async () => {
      fetched.pages.set(page("a"), html("Wort ".repeat(12_000)));
      fetched.pages.set(page("b"), html("Satz ".repeat(12_000)));
      await expect(
        snapshot(scope, site([page("a"), page("b")])),
      ).rejects.toMatchObject({ code: "DOCUMENT_TOO_LARGE" });
    });

    it("keeps pages that differ only in their query apart", async () => {
      fetched.pages.set(`${page("a")}?v=1`, html("Erste Fassung"));
      fetched.pages.set(`${page("a")}?v=2`, html("Zweite Fassung"));
      const snap = await snapshot(
        scope,
        site([`${page("a")}?v=1`, `${page("a")}?v=2`]),
      );
      expect(snap.files.map((f) => f.path)).toEqual([
        "/docs/a?v=1",
        "/docs/a?v=2",
      ]);
    });

    it("skips and counts a page with possible credentials or a failed read", async () => {
      fetched.pages.set(page("a"), html("Kalender teilen"));
      // The fake header is split so the repository secret scan does not flag it.
      fetched.pages.set(page("secret"), html("-----BEGIN " + "PRIVATE KEY-----"));
      fetched.pages.set(page("gone"), new Error("SOURCE_NOT_FOUND"));
      const snap = await snapshot(
        scope,
        site([page("a"), page("secret"), page("gone")]),
      );
      expect(snap.files.map((f) => f.path)).toEqual(["/docs/a"]);
      expect(snap).toMatchObject({
        partial: true,
        skipped: 2,
        unreadablePaths: ["/docs/secret"],
      });
    });

    it("refuses a page outside the site's root", async () => {
      await expect(
        snapshot(scope, site(["https://example.invalid/private/a"])),
      ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    });

    it("still reads the address alone without pages", async () => {
      fetched.html = html("Eine einzelne Seite");
      const snap = await snapshot(scope, site([]));
      expect(snap.files.map((f) => f.path)).toEqual(["/docs"]);
    });
  });
});
