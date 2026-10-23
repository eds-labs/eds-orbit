import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Entity } from "@/lib/api";
import {
  IndexStateBadge,
  SourceIndexPanel,
  stateTone,
  type SourceIndexStatus,
} from "./index-status";

const source = {
  id: "s1",
  data: { authority: "generated", maxAgeHours: 168 },
} as unknown as Entity;
const status = (over: Partial<SourceIndexStatus> = {}): SourceIndexStatus => ({
  sourceId: "s1",
  name: "FamilyPlan",
  state: "ready",
  blockers: [],
  documents: 12,
  chunks: 84,
  embeddedChunks: 0,
  searchMode: "lexical",
  outdatedDocuments: 0,
  staleDocuments: 0,
  lastIndexedAt: "2026-10-20T14:43:15.980Z",
  jobs: { pending: 0, failed: 0, lastError: null },
  ...over,
});
const render = (
  s: SourceIndexStatus,
  isOwner = true,
  locale: "en" | "de" = "en",
) =>
  renderToStaticMarkup(
    <SourceIndexPanel
      projectId="p1"
      source={source}
      status={s}
      isOwner={isOwner}
      locale={locale}
      timezone="Europe/Berlin"
      onChanged={() => {}}
    />,
  );

describe("knowledge source index status", () => {
  it("shows counts, search mode and the owner's repairs", () => {
    const html = render(status());
    expect(html).toContain(">12<");
    expect(html).toContain(">84<");
    expect(html).toContain("0 / 84");
    expect(html).toContain("Full-text search (no embeddings)");
    expect(html).toContain("Reindex");
    expect(html).toContain("Source settings");
  });

  it("explains every blocker and the last error, in German too", () => {
    const html = render(
      status({
        state: "failed",
        blockers: [
          "generated_authority",
          "outdated_generation",
          "stale_documents",
        ],
        searchMode: "none",
        jobs: { pending: 1, failed: 2, lastError: "EMBEDDING_COST_UNKNOWN" },
      }),
      false,
      "de",
    );
    expect(html).toContain("Als generierter Inhalt eingestuft");
    expect(html).toContain("älteren Fassung der Quelleinstellungen");
    expect(html).toContain("Frischefenster");
    expect(html).toContain("EMBEDDING_COST_UNKNOWN");
    expect(html).toContain("1 / 2");
    expect(html).toContain("Nicht durchsuchbar");
    // Viewers see the state, not the repairs.
    expect(html).not.toContain("Neu indexieren");
  });

  it("maps states to badge tones", () => {
    expect(stateTone("ready")).toBe("success");
    expect(stateTone("failed")).toBe("danger");
    expect(stateTone("stale")).toBe("warning");
    expect(stateTone("pending")).toBe("blue");
    expect(
      renderToStaticMarkup(
        <IndexStateBadge status={status({ state: "indexing" })} locale="de" />,
      ),
    ).toContain("Wird indexiert");
  });
});
