import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

// The widget is a plain script served from apps/web/public (WP5.4). It is
// evaluated here in an empty global without a document, where it must load
// without touching anything and expose its helpers.
const source = readFileSync(
  new URL("../../../public/widget/v1.js", import.meta.url),
  "utf8",
);
function load() {
  const global: Record<string, any> = {};
  new Function("window", "globalThis", source)(global, global);
  return global.OrbitSupport as {
    init(config: unknown): unknown;
    _internals: {
      text(locale?: string): Record<string, string>;
      apiBase(src: string, key: string): string | null;
      parseSse(buffer: string): {
        events: Array<{ id: number | null; event: string; data: string }>;
        rest: string;
      };
    };
  };
}

describe("support widget script (WP5.4)", () => {
  it("loads without a document and never throws on init", () => {
    const widget = load();
    expect(widget).toBeDefined();
    expect(widget.init({ key: "pk_" + "a".repeat(32) })).toBeNull();
    expect(widget.init(undefined)).toBeNull();
  });

  it("builds the API base from the script origin and refuses malformed keys", () => {
    const { apiBase } = load()._internals;
    const key = "pk_" + "A".repeat(32);
    expect(apiBase("https://orbit.example/widget/v1.js", key)).toBe(
      `https://orbit.example/api/public/support/${key}`,
    );
    expect(
      apiBase("https://orbit.example/widget/v1.js", "pk_short"),
    ).toBeNull();
    expect(apiBase("https://orbit.example/widget/v1.js", "../evil")).toBeNull();
    expect(apiBase("not a url", key)).toBeNull();
  });

  it("parses server-sent events across chunk boundaries", () => {
    const { parseSse } = load()._internals;
    const first = parseSse('retry: 1000\n\nid: 1\nevent: message\ndata: {"a"');
    expect(first.events).toEqual([]);
    const second = parseSse(
      first.rest + ":1}\n\n: keepalive\n\nid: 2\ndata: x\n\n",
    );
    expect(second.events).toEqual([
      { id: 1, event: "message", data: '{"a":1}' },
      { id: 2, event: "message", data: "x" },
    ]);
    expect(second.rest).toBe("");
  });

  it("speaks German or English", () => {
    const { text } = load()._internals;
    expect(text("de-DE").send).toBe("Senden");
    expect(text("fr").send).toBe("Send");
  });

  it("stays within the size budget (50 KB gzip)", () => {
    expect(gzipSync(source).byteLength).toBeLessThan(50_000);
  });
});
