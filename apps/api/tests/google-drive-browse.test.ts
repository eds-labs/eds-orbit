import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  driveAncestry,
  driveChildrenUrl,
  driveFoldersUrl,
  forgetDriveAncestry,
} from "../src/platform/connections/google-drive.ts";

// The Drive tree (2026-11-05 Drive page): the parent walk returns the path
// from the project root and caches folder chains for 60 seconds.

const FOLDER = "application/vnd.google-apps.folder";
type Node = { id: string; name: string; parents?: string[] };
let nodes: Record<string, Node> = {};
let fetched: string[] = [];

const node = (id: string, name: string, parent?: string): Node => ({
  id,
  name,
  ...(parent ? { parents: [parent] } : {}),
});

beforeEach(() => {
  fetched = [];
  nodes = {};
  for (const n of [
    node("rootFolder0001", "Root"),
    node("folderAAAA0001", "A", "rootFolder0001"),
    node("folderBBBB0001", "B", "folderAAAA0001"),
    node("orphanXXXX0001", "Orphan"),
  ])
    nodes[n.id] = n;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const id = url.pathname.split("/").at(-1)!;
      fetched.push(id);
      const found = nodes[id];
      if (!found) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ ...found, mimeType: FOLDER }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  forgetDriveAncestry("p1");
  forgetDriveAncestry("p2");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Drive ancestry", () => {
  it("returns the chain root first", async () => {
    expect(
      await driveAncestry("token", "folderBBBB0001", "rootFolder0001"),
    ).toEqual([
      { id: "rootFolder0001", name: "Root" },
      { id: "folderAAAA0001", name: "A" },
      { id: "folderBBBB0001", name: "B" },
    ]);
  });

  it("returns the root alone for the root", async () => {
    expect(
      await driveAncestry("token", "rootFolder0001", "rootFolder0001"),
    ).toEqual([{ id: "rootFolder0001", name: "Root" }]);
  });

  it("refuses a chain that ends without the root", async () => {
    expect(
      await driveAncestry("token", "orphanXXXX0001", "rootFolder0001"),
    ).toBeNull();
  });

  it("stops after 30 levels", async () => {
    let parent = "rootFolder0001";
    for (let i = 0; i < 31; i++) {
      const id = `deepFolder${String(i).padStart(4, "0")}`;
      nodes[id] = node(id, `D${i}`, parent);
      parent = id;
    }
    expect(await driveAncestry("token", parent, "rootFolder0001")).toBeNull();
  });

  it("cached folders skip Google", async () => {
    await driveAncestry("token", "folderBBBB0001", "rootFolder0001", "p1");
    fetched = [];
    const again = await driveAncestry(
      "token",
      "folderBBBB0001",
      "rootFolder0001",
      "p1",
    );
    expect(again?.map((p) => p.id)).toEqual([
      "rootFolder0001",
      "folderAAAA0001",
      "folderBBBB0001",
    ]);
    expect(fetched).toEqual([]);
  });

  it("a cached ancestor shortens the walk", async () => {
    await driveAncestry("token", "folderAAAA0001", "rootFolder0001", "p1");
    fetched = [];
    const path = await driveAncestry(
      "token",
      "folderBBBB0001",
      "rootFolder0001",
      "p1",
    );
    expect(path?.map((p) => p.name)).toEqual(["Root", "A", "B"]);
    expect(fetched).toEqual(["folderBBBB0001"]);
  });

  it("cache expires after 60 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await driveAncestry("token", "folderBBBB0001", "rootFolder0001", "p1");
    vi.setSystemTime(Date.now() + 60_001);
    fetched = [];
    await driveAncestry("token", "folderBBBB0001", "rootFolder0001", "p1");
    expect(fetched).toContain("folderBBBB0001");
  });

  it("a cache hit does not extend the 60 s bound", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    await driveAncestry("token", "folderBBBB0001", "rootFolder0001", "p1");
    vi.setSystemTime(start + 59_000);
    fetched = [];
    await driveAncestry("token", "folderBBBB0001", "rootFolder0001", "p1");
    expect(fetched).toEqual([]);
    vi.setSystemTime(start + 61_000);
    await driveAncestry("token", "folderBBBB0001", "rootFolder0001", "p1");
    expect(fetched).toContain("folderBBBB0001");
  });

  it("a chain built on a cached ancestor expires with that ancestor", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    await driveAncestry("token", "folderAAAA0001", "rootFolder0001", "p1");
    vi.setSystemTime(start + 30_000);
    await driveAncestry("token", "folderBBBB0001", "rootFolder0001", "p1");
    vi.setSystemTime(start + 61_000);
    fetched = [];
    await driveAncestry("token", "folderBBBB0001", "rootFolder0001", "p1");
    expect(fetched).toContain("folderAAAA0001");
  });

  it("forgetDriveAncestry clears one project", async () => {
    await driveAncestry("token", "folderBBBB0001", "rootFolder0001", "p1");
    await driveAncestry("token", "folderBBBB0001", "rootFolder0001", "p2");
    forgetDriveAncestry("p1");
    fetched = [];
    await driveAncestry("token", "folderBBBB0001", "rootFolder0001", "p2");
    expect(fetched).toEqual([]);
    await driveAncestry("token", "folderBBBB0001", "rootFolder0001", "p1");
    expect(fetched).toContain("folderBBBB0001");
  });
});

describe("Drive listing queries", () => {
  it("folders query lists only folders by name", () => {
    const url = new URL(driveFoldersUrl("folderAAAA0001", "next-page"));
    expect(url.searchParams.get("q")).toBe(
      `'folderAAAA0001' in parents and mimeType = '${FOLDER}' and trashed = false`,
    );
    expect(url.searchParams.get("orderBy")).toBe("name");
    expect(url.searchParams.get("pageSize")).toBe("200");
    expect(url.searchParams.get("pageToken")).toBe("next-page");
    expect(url.searchParams.get("fields")).toBe("nextPageToken,files(id,name)");
  });

  it("files query sorts folders first by name by default", () => {
    const url = new URL(driveChildrenUrl("folderAAAA0001"));
    expect(url.searchParams.get("orderBy")).toBe("folder,name");
    expect(url.searchParams.get("q")).toBe(
      "'folderAAAA0001' in parents and trashed = false",
    );
  });

  it("files query sorts by modification and filters images", () => {
    const url = new URL(
      driveChildrenUrl("folderAAAA0001", {
        sort: "modified",
        kind: "image",
        query: "it's",
      }),
    );
    expect(url.searchParams.get("orderBy")).toBe("folder,modifiedTime desc");
    expect(url.searchParams.get("q")).toBe(
      `'folderAAAA0001' in parents and trashed = false and (mimeType = '${FOLDER}' or mimeType contains 'image/') and name contains 'it\\'s'`,
    );
  });
});
