import { afterEach, describe, expect, it, vi } from "vitest";
import { webRegistry } from "@/modules/registry";
import { buildNavGroups } from "./nav-groups";
import {
  groupBadge,
  isGroupOpen,
  readCollapsed,
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
  it("keeps the active group open", () => {
    const collapsed = new Set(["marketing", "support"]);
    expect(isGroupOpen("marketing", collapsed, "marketing")).toBe(true);
    expect(isGroupOpen("support", collapsed, "marketing")).toBe(false);
    expect(isGroupOpen("knowledge", collapsed, "marketing")).toBe(true);
    expect(isGroupOpen("support", collapsed, undefined)).toBe(false);
  });

  it("an unknown stored id is harmless", () => {
    const collapsed = new Set(["gone"]);
    for (const id of ["marketing", "support", "knowledge", "project"])
      expect(isGroupOpen(id, collapsed, undefined), id).toBe(true);
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
