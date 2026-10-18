import { afterEach, describe, expect, it, vi } from "vitest";
import { webRegistry } from "@/modules/registry";
import { buildNavGroups } from "./nav-groups";
import {
  groupBadge,
  readCollapsed,
  revealGroup,
  toggleCollapsed,
  writeCollapsed,
} from "./nav-collapse";
import { routeTable } from "./routes";

const KEY = "orbit.nav.collapsed";

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("collapsed groups in storage", () => {
  it("returns an empty set when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readCollapsed()).toEqual(new Set());
  });

  it("returns an empty set without storage or with a broken value", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readCollapsed()).toEqual(new Set());
    for (const value of ["{", '"marketing"', '{"marketing":true}', "null"]) {
      vi.stubGlobal("localStorage", memoryStorage({ [KEY]: value }));
      expect(readCollapsed(), value).toEqual(new Set());
    }
  });

  it("ignores non-string ids", () => {
    vi.stubGlobal("localStorage", memoryStorage({ [KEY]: '["marketing",3]' }));
    expect(readCollapsed()).toEqual(new Set(["marketing"]));
  });

  it("toggles a group and remembers it", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const before = new Set<string>();
    const after = toggleCollapsed(before, "support");
    expect(after).toEqual(new Set(["support"]));
    expect(before.size).toBe(0);
    writeCollapsed(after);
    expect(storage.items.get(KEY)).toBe('["support"]');
    expect(readCollapsed()).toEqual(new Set(["support"]));
    writeCollapsed(toggleCollapsed(after, "support"));
    expect(readCollapsed()).toEqual(new Set());
  });

  it("swallows storage errors on write", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("quota");
      },
    });
    expect(() => writeCollapsed(new Set(["marketing"]))).not.toThrow();
  });
});

describe("group state", () => {
  it("opens the group of the open page on navigation", () => {
    const collapsed = new Set(["marketing", "support"]);
    const next = revealGroup(collapsed, "marketing");
    expect(next).toEqual(new Set(["support"]));
    expect(collapsed).toEqual(new Set(["marketing", "support"]));
  });

  it("returns the same set when the group is not collapsed", () => {
    const collapsed = new Set(["support"]);
    expect(revealGroup(collapsed, "marketing")).toBe(collapsed);
    expect(revealGroup(collapsed, undefined)).toBe(collapsed);
    // An unknown stored id is harmless.
    expect(revealGroup(new Set(["gone"]), "top")).toEqual(new Set(["gone"]));
  });

  it("sums the badges of a group's entries", () => {
    const table = routeTable(webRegistry);
    const groups = buildNavGroups(
      table.routes,
      webRegistry.modules.map((m) => ({ ...m, enabled: true })),
    );
    const marketing = groups.find((g) => g.id === "marketing")!;
    expect(groupBadge(marketing, {})).toBe(0);
    expect(groupBadge(marketing, { approvals: 3, content: 2, home: 7 })).toBe(
      5,
    );
  });
});
