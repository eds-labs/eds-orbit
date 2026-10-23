import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { csvFile, csvRow } from "../src/modules/finance/exports/csv.ts";
import { storedZip } from "../src/modules/finance/exports/zip.ts";

const hasUnzip = spawnSync("unzip", ["-v"]).status === 0;

describe("finance csv", () => {
  it("csv escapes quotes, newlines and formula prefixes", () => {
    expect(csvRow(["a", 'say "hi"', "x,y", "line\nbreak", null, 5])).toBe(
      'a,"say ""hi""","x,y","line\nbreak",,5\r\n',
    );
    expect(csvRow(["=SUM(A1)", "+1", "-1", "@cmd", "\tx", "\rx", "ok-"])).toBe(
      "'=SUM(A1),'+1,'-1,'@cmd,'\tx,\"'\rx\",ok-\r\n",
    );
    expect(Array.from(csvFile([csvRow(["é"])]).subarray(0, 3))).toEqual([
      0xef, 0xbb, 0xbf,
    ]);
  });
});

describe("finance zip", () => {
  const entries = [
    {
      name: "b/Rechnung ä.txt",
      bytes: Buffer.from("hello"),
      date: new Date("2025-03-04T10:20:30Z"),
    },
    {
      name: "b/Rechnung ä.txt",
      bytes: Buffer.from("world!"),
      date: new Date("2025-03-04T10:20:30Z"),
    },
    {
      name: "../evil.txt",
      bytes: Buffer.from(""),
      date: new Date("1970-01-01T00:00:00Z"),
    },
  ];

  it.skipIf(!hasUnzip)("zip opens with unzip -l", () => {
    const dir = mkdtempSync(join(tmpdir(), "orbit-zip-"));
    try {
      const path = join(dir, "t.zip");
      writeFileSync(path, storedZip(entries));
      const listing = spawnSync("unzip", ["-l", path], { encoding: "utf8" });
      expect(listing.status).toBe(0);
      expect(listing.stdout).toContain("b/Rechnung_a_.txt");
      expect(listing.stdout).toContain("b/Rechnung_a_-2.txt");
      expect(listing.stdout).toContain("evil.txt");
      const test = spawnSync("unzip", ["-t", path], { encoding: "utf8" });
      expect(test.stdout).toContain("No errors detected");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("crc matches", () => {
    const zip = storedZip(entries);
    const view = new DataView(zip.buffer, zip.byteOffset);
    // First local header: CRC at 14, size at 18, name length at 26.
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0);
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
    const nameLength = view.getUint16(26, true);
    const size = view.getUint32(18, true);
    const body = zip.subarray(30 + nameLength, 30 + nameLength + size);
    expect(Buffer.from(body).toString()).toBe("hello");
    expect(view.getUint32(14, true)).toBe(crc32(Buffer.from("hello")));
    // End record counts every entry.
    expect(view.getUint16(zip.length - 22 + 10, true)).toBe(3);
  });

  it("refuses more entries than a non-ZIP64 archive holds", () => {
    const many = Array.from({ length: 65536 }, (_, i) => ({
      name: `f${i}`,
      bytes: new Uint8Array(0),
      date: new Date(),
    }));
    expect(() => storedZip(many)).toThrowError(
      expect.objectContaining({ status: 413 }),
    );
  });
});
