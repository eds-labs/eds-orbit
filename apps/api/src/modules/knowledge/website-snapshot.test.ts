import { beforeEach, describe, expect, it, vi } from "vitest";

// A website draft reads one page: up to 1 MB of HTML (inline styles and
// scripts included, as on familyplan.cloud) and up to 100,000 characters
// of text, the same bounds as an uploaded file.

const fetched = vi.hoisted(() => ({ html: "", options: null as unknown }));
vi.mock("../../../../../packages/knowledge/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../../../packages/knowledge/src/index.ts")>()),
  fetchApprovedDocument: vi.fn(async (_url: string, options: unknown) => {
    fetched.options = options;
    return { bytes: Buffer.from(fetched.html), mimeType: "text/html", url: "https://example.invalid/" };
  }),
}));
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
});
