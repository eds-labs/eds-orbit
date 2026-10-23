import { crc32 } from "node:zlib";
import { DomainError } from "../../../shared.ts";

// A minimal ZIP writer: method 0 (stored), no ZIP64. Receipts are already
// compressed (PDF, images), so storing keeps the writer small and exact.

export const ZIP_MAX_ENTRIES = 65535;
export const ZIP_MAX_BYTES = 4 * 1024 ** 3 - 1;

export type ZipEntry = { name: string; bytes: Uint8Array; date: Date };

/** One name part: no folders, only letters, digits, `.`, `_` and `-`. */
export const safeNamePart = (raw: string): string =>
  raw.normalize("NFKD").replace(/[^A-Za-z0-9._-]/g, "_");

/** Entry name characters: letters, digits, `.`, `_`, `-` and `/` for folders. */
export function safeEntryName(raw: string): string {
  const parts = raw
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._\-/]/g, "_")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..");
  return parts.join("/") || "file";
}

/** `name`, or `name-2`, `name-3`, … before the extension, not yet in `taken`. */
export function uniqueEntryName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const slash = name.lastIndexOf("/");
  const split = dot > slash + 1 ? dot : name.length;
  const stem = name.slice(0, split);
  const extension = name.slice(split);
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1)
    candidate = `${stem}-${n}${extension}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

function dosDateTime(date: Date): { time: number; day: number } {
  const year = date.getUTCFullYear();
  if (year < 1980) return { time: 0, day: (1 << 5) | 1 };
  return {
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      (date.getUTCSeconds() >> 1),
    day:
      ((year - 1980) << 9) |
      ((date.getUTCMonth() + 1) << 5) |
      date.getUTCDate(),
  };
}

/** The ZIP archive of `entries`; 413 EXPORT_TOO_LARGE past the non-ZIP64 limits. */
export function storedZip(entries: ZipEntry[]): Uint8Array {
  if (entries.length > ZIP_MAX_ENTRIES)
    throw new DomainError("EXPORT_TOO_LARGE", 413);
  const encoder = new TextEncoder();
  const taken = new Set<string>();
  const prepared = entries.map((entry) => ({
    ...entry,
    nameBytes: encoder.encode(
      uniqueEntryName(safeEntryName(entry.name), taken),
    ),
    crc: crc32(entry.bytes),
    when: dosDateTime(entry.date),
  }));
  let total = 22;
  for (const e of prepared)
    total += 30 + 46 + 2 * e.nameBytes.length + e.bytes.length;
  if (total > ZIP_MAX_BYTES) throw new DomainError("EXPORT_TOO_LARGE", 413);

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let pos = 0;
  const offsets: number[] = [];
  for (const e of prepared) {
    offsets.push(pos);
    view.setUint32(pos, 0x04034b50, true);
    view.setUint16(pos + 4, 20, true); // version needed
    view.setUint16(pos + 6, 0x0800, true); // UTF-8 names
    view.setUint16(pos + 8, 0, true); // stored
    view.setUint16(pos + 10, e.when.time, true);
    view.setUint16(pos + 12, e.when.day, true);
    view.setUint32(pos + 14, e.crc, true);
    view.setUint32(pos + 18, e.bytes.length, true);
    view.setUint32(pos + 22, e.bytes.length, true);
    view.setUint16(pos + 26, e.nameBytes.length, true);
    view.setUint16(pos + 28, 0, true);
    out.set(e.nameBytes, pos + 30);
    out.set(e.bytes, pos + 30 + e.nameBytes.length);
    pos += 30 + e.nameBytes.length + e.bytes.length;
  }
  const centralStart = pos;
  prepared.forEach((e, i) => {
    view.setUint32(pos, 0x02014b50, true);
    view.setUint16(pos + 4, 20, true); // made by
    view.setUint16(pos + 6, 20, true);
    view.setUint16(pos + 8, 0x0800, true);
    view.setUint16(pos + 10, 0, true);
    view.setUint16(pos + 12, e.when.time, true);
    view.setUint16(pos + 14, e.when.day, true);
    view.setUint32(pos + 16, e.crc, true);
    view.setUint32(pos + 20, e.bytes.length, true);
    view.setUint32(pos + 24, e.bytes.length, true);
    view.setUint16(pos + 28, e.nameBytes.length, true);
    view.setUint32(pos + 42, offsets[i]!, true);
    out.set(e.nameBytes, pos + 46);
    pos += 46 + e.nameBytes.length;
  });
  view.setUint32(pos, 0x06054b50, true);
  view.setUint16(pos + 8, prepared.length, true);
  view.setUint16(pos + 10, prepared.length, true);
  view.setUint32(pos + 12, pos - centralStart, true);
  view.setUint32(pos + 16, centralStart, true);
  return out;
}
