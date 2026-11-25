import { DomainError } from "../../../shared.ts";

export const SOCIAL_VIDEO_MIME = "video/mp4";
export const SOCIAL_VIDEO_MAX_BYTES = 20 * 1024 * 1024;

type Box = { type: string; data: number; end: number };

const invalid = () => new DomainError("SOCIAL_VIDEO_INVALID", 422);

/** Read only bounded ISO BMFF metadata. Sample payloads are never decoded. */
function* boxes(file: Buffer, start: number, end: number): Generator<Box> {
  let count = 0;
  for (let offset = start; offset < end;) {
    if (++count > 4096) throw invalid();
    if (end - offset < 8) throw invalid();
    let length = file.readUInt32BE(offset);
    let header = 8;
    if (length === 1) {
      if (end - offset < 16) throw invalid();
      const extended = file.readBigUInt64BE(offset + 8);
      if (extended > BigInt(end - offset)) throw invalid();
      length = Number(extended);
      header = 16;
    } else if (length === 0) {
      length = end - offset;
    }
    if (length < header || length > end - offset) throw invalid();
    yield {
      type: file.toString("latin1", offset + 4, offset + 8),
      data: offset + header,
      end: offset + length,
    };
    offset += length;
  }
}

function child(file: Buffer, parent: Box, type: string) {
  for (const box of boxes(file, parent.data, parent.end)) {
    if (box.type === type) return box;
  }
  throw invalid();
}

function duration(file: Buffer, box: Box) {
  if (box.end - box.data < 20) throw invalid();
  const version = file[box.data];
  if (version !== 0 && version !== 1) throw invalid();
  if (version === 1 && box.end - box.data < 32) throw invalid();
  const at = box.data + (version === 1 ? 20 : 12);
  const scale = file.readUInt32BE(at);
  const samples =
    version === 1
      ? file.readBigUInt64BE(at + 4)
      : BigInt(file.readUInt32BE(at + 4));
  if (!scale || samples === 0n || samples > BigInt(scale) * 60n)
    throw invalid();
  return Number((samples * 1000n + BigInt(scale) - 1n) / BigInt(scale));
}

export function socialVideoFacts(bytes: Uint8Array) {
  const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let movie: Box | undefined;
  let payload = false;
  let fileType = false;
  for (const box of boxes(file, 0, file.length)) {
    if (box.type === "moof") throw invalid();
    if (box.type === "ftyp" && box.data === 8 && box.end - box.data >= 8)
      fileType = true;
    if (box.type === "mdat" && box.end > box.data) payload = true;
    if (box.type === "moov") {
      if (movie) throw invalid();
      movie = box;
    }
  }
  if (!fileType || !payload || !movie) throw invalid();
  const movieDuration = duration(file, child(file, movie, "mvhd"));
  let video: { width: number; height: number; durationMs: number } | undefined;

  for (const track of boxes(file, movie.data, movie.end)) {
    if (track.type !== "trak") continue;
    const media = child(file, track, "mdia");
    const handler = child(file, media, "hdlr");
    if (handler.end - handler.data < 12) throw invalid();
    if (file.toString("latin1", handler.data + 8, handler.data + 12) !== "vide")
      continue;
    if (video) throw invalid();
    const table = child(file, child(file, media, "minf"), "stbl");
    const entries = child(file, table, "stsd");
    if (
      entries.end - entries.data < 8 ||
      file.readUInt32BE(entries.data + 4) !== 1
    )
      throw invalid();
    const [entry] = boxes(file, entries.data + 8, entries.end);
    if (
      !entry ||
      entry.end !== entries.end ||
      !["avc1", "avc3"].includes(entry.type) ||
      entry.end - entry.data < 86
    )
      throw invalid();
    const config = child(file, { ...entry, data: entry.data + 78 }, "avcC");
    if (config.end - config.data < 7 || file[config.data] !== 1)
      throw invalid();
    const width = file.readUInt16BE(entry.data + 24);
    const height = file.readUInt16BE(entry.data + 26);
    if (width < 270 || height > 3840 || width * 16 !== height * 9)
      throw invalid();
    video = {
      width,
      height,
      durationMs: Math.max(
        movieDuration,
        duration(file, child(file, media, "mdhd")),
      ),
    };
  }
  if (!video) throw invalid();
  return video;
}

/** The single byte range used by browser video controls. */
export function videoRange(header: string, size: number) {
  const match = /^bytes=(\d{0,12})-(\d{0,12})$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  const end =
    match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return start < size && end >= start ? { start, end } : null;
}
