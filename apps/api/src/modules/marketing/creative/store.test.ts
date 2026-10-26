import { describe, expect, it } from "vitest";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { creativeView, type CreativeRecord } from "./store.ts";

const scope: Scope = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  userId: "00000000-0000-4000-8000-000000000003",
  role: "editor",
};

describe("creativeView", () => {
  it("links each rendition to the asset content route of its project", () => {
    const record = {
      profileVersion: 3,
      template: "lifestyle",
      variant: "text_bottom",
      status: "composed",
      renditions: [
        {
          format: "feed_portrait",
          assetId: "00000000-0000-4000-8000-0000000000a1",
          width: 1080,
          height: 1350,
          bytes: 1234,
          sha256: "a".repeat(64),
        },
      ],
    } as unknown as CreativeRecord;
    const view = creativeView(
      {
        id: "00000000-0000-4000-8000-0000000000c1",
        version: 2,
        data: record,
        createdAt: new Date("2026-10-26T10:00:00.000Z"),
        updatedAt: new Date("2026-10-26T11:00:00.000Z"),
      } as never,
      scope,
    );
    expect(view).toMatchObject({
      id: "00000000-0000-4000-8000-0000000000c1",
      version: 2,
      createdAt: "2026-10-26T10:00:00.000Z",
      updatedAt: "2026-10-26T11:00:00.000Z",
      status: "composed",
      template: "lifestyle",
    });
    expect(view.renditions).toEqual([
      {
        ...record.renditions[0],
        href: `/api/projects/${scope.projectId}/assets/00000000-0000-4000-8000-0000000000a1/content`,
      },
    ]);
  });

  it("shows a creative without renditions as an empty list", () => {
    const view = creativeView(
      {
        id: "00000000-0000-4000-8000-0000000000c1",
        version: 1,
        data: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never,
      scope,
    );
    expect(view.renditions).toEqual([]);
  });
});
