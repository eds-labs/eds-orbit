import type { SpeechMime } from "./speech.ts";

/**
 * Server-side duration of a recording (ADR 0024 item 2), read from the
 * container in memory without a decoder or a dependency. The estimate that
 * the budget reserves before a transcription rests on it, so it takes the
 * largest of every duration the container states or implies:
 *
 * - WebM (Matroska, Opus): the Info duration when present (MediaRecorder in
 *   Chrome writes none), the block timestamps, and the sum of the Opus packet
 *   durations from each packet's TOC byte. The packet sum is what a decoder
 *   plays, so rewritten timestamps cannot shorten it.
 * - MP4 (Safari, AAC): the movie and media header durations, the sample
 *   table (`stts`), the fragment runs (`moof`/`trun`) and, for AAC, the
 *   sample count times 1024 samples per frame.
 *
 * Anything it cannot parse is `SPEECH_UNREADABLE`; the caller refuses it.
 */

export type MeasuredAudio = {
  durationSeconds: number;
  container: "webm" | "mp4";
};

const unreadable = () => new Error("SPEECH_UNREADABLE");

export function measureAudioDuration(
  bytes: Uint8Array,
  mime: SpeechMime,
): MeasuredAudio {
  const seconds =
    mime === "audio/webm" ? webmDuration(bytes) : mp4Duration(bytes);
  if (!Number.isFinite(seconds) || seconds <= 0) throw unreadable();
  return {
    durationSeconds: seconds,
    container: mime === "audio/webm" ? "webm" : "mp4",
  };
}

// ---------------------------------------------------------------- WebM ----

const EBML = 0x1a45dfa3;
const DOC_TYPE = 0x4282;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const TRACK_TYPE = 0x83;
const CODEC_ID = 0x86;
const CLUSTER = 0x1f43b675;
const TIMECODE = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
/** Elements that may follow a cluster of unknown size at segment level. */
const SEGMENT_LEVEL = new Set([
  CLUSTER,
  INFO,
  TRACKS,
  0x1c53bb6b, // Cues
  0x1254c367, // Tags
  0x114d9b74, // SeekHead
  0x1043a770, // Chapters
  0x1941a469, // Attachments
]);

type Element = {
  id: number;
  start: number;
  end: number;
  unknown: boolean;
  next: number;
};

/** An EBML element header at `pos`; its data runs from `start` to `end`. */
function element(b: Uint8Array, pos: number, limit: number): Element {
  if (pos >= limit) throw unreadable();
  const first = b[pos]!;
  let idLength = 1;
  while (idLength <= 4 && !(first & (0x80 >> (idLength - 1)))) idLength++;
  if (idLength > 4 || pos + idLength > limit) throw unreadable();
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + b[pos + i]!;
  const sizeAt = pos + idLength;
  if (sizeAt >= limit) throw unreadable();
  const sizeFirst = b[sizeAt]!;
  let sizeLength = 1;
  while (sizeLength <= 8 && !(sizeFirst & (0x80 >> (sizeLength - 1))))
    sizeLength++;
  if (sizeLength > 8 || sizeAt + sizeLength > limit) throw unreadable();
  let size = sizeFirst & (0xff >> sizeLength);
  let allOnes = size === 0xff >> sizeLength;
  for (let i = 1; i < sizeLength; i++) {
    const byte = b[sizeAt + i]!;
    size = size * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  const start = sizeAt + sizeLength;
  if (allOnes) return { id, start, end: limit, unknown: true, next: limit };
  const end = start + size;
  // A recording cut off mid-element ends at the buffer.
  const clamped = Math.min(end, limit);
  return { id, start, end: clamped, unknown: false, next: clamped };
}

const uint = (b: Uint8Array, e: Element) => {
  if (e.end - e.start > 8) throw unreadable();
  let value = 0;
  for (let i = e.start; i < e.end; i++) value = value * 256 + b[i]!;
  return value;
};
const text = (b: Uint8Array, e: Element) =>
  String.fromCharCode(
    ...b.subarray(e.start, Math.min(e.end, e.start + 64)),
  ).replace(/\0+$/, "");
function float(b: Uint8Array, e: Element) {
  const view = new DataView(b.buffer, b.byteOffset + e.start, e.end - e.start);
  if (e.end - e.start === 4) return view.getFloat32(0);
  if (e.end - e.start === 8) return view.getFloat64(0);
  if (e.end - e.start === 0) return 0;
  throw unreadable();
}

/** Milliseconds of one Opus packet from its TOC byte (RFC 6716 §3.1). */
export function opusPacketMs(packet: Uint8Array): number {
  if (!packet.length) throw unreadable();
  const toc = packet[0]!;
  const config = toc >> 3;
  const frameMs =
    config < 12
      ? [10, 20, 40, 60][config % 4]!
      : config < 16
        ? [10, 20][config % 2]!
        : [2.5, 5, 10, 20][config % 4]!;
  const code = toc & 3;
  let frames: number;
  if (code === 0) frames = 1;
  else if (code < 3) frames = 2;
  else {
    if (packet.length < 2) throw unreadable();
    frames = packet[1]! & 0x3f;
  }
  const ms = frames * frameMs;
  if (!frames || ms > 120) throw unreadable();
  return ms;
}

function webmDuration(b: Uint8Array): number {
  const limit = b.length;
  const header = element(b, 0, limit);
  if (header.id !== EBML || header.unknown) throw unreadable();
  let docType = "";
  for (let p = header.start; p < header.end;) {
    const child = element(b, p, header.end);
    if (child.id === DOC_TYPE) docType = text(b, child);
    p = child.next;
  }
  if (docType !== "webm") throw unreadable();
  const segment = element(b, header.next, limit);
  if (segment.id !== SEGMENT) throw unreadable();

  let scale = 1_000_000; // nanoseconds per timestamp tick (default)
  let infoSeconds = 0;
  const audioTracks = new Map<number, string>();
  const blocks: Array<{
    cluster: number;
    relative: number;
    track: number;
    packet: Uint8Array;
  }> = [];
  let steps = 0;

  function block(at: number, end: number, cluster: number) {
    // Track number (an EBML size-style integer), int16 timestamp, flags.
    const first = b[at];
    if (first === undefined) throw unreadable();
    let length = 1;
    while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
    if (length > 8 || at + length + 3 > end) throw unreadable();
    let track = first & (0xff >> length);
    for (let i = 1; i < length; i++) track = track * 256 + b[at + i]!;
    const view = new DataView(b.buffer, b.byteOffset + at + length, 2);
    const relative = view.getInt16(0);
    const flags = b[at + length + 2]!;
    // MediaRecorder never laces; a laced block is not read.
    if ((flags >> 1) & 3) throw unreadable();
    blocks.push({
      cluster,
      relative,
      track,
      packet: b.subarray(at + length + 3, end),
    });
  }

  function clusterChildren(start: number, end: number, unknownSize: boolean) {
    let timecode = 0;
    let p = start;
    while (p < end) {
      if (++steps > 1_000_000) throw unreadable();
      const child = element(b, p, end);
      if (unknownSize && SEGMENT_LEVEL.has(child.id)) return p;
      if (child.id === TIMECODE) timecode = uint(b, child);
      else if (child.id === SIMPLE_BLOCK)
        block(child.start, child.end, timecode);
      else if (child.id === BLOCK_GROUP) {
        for (let q = child.start; q < child.end;) {
          const inner = element(b, q, child.end);
          if (inner.id === BLOCK) block(inner.start, inner.end, timecode);
          q = inner.next;
        }
      } else if (child.unknown) throw unreadable();
      p = child.next;
    }
    return end;
  }

  let p = segment.start;
  while (p < segment.end) {
    if (++steps > 1_000_000) throw unreadable();
    const child = element(b, p, segment.end);
    if (child.id === INFO) {
      for (let q = child.start; q < child.end;) {
        const inner = element(b, q, child.end);
        if (inner.id === TIMECODE_SCALE) scale = uint(b, inner);
        if (inner.id === DURATION) infoSeconds = float(b, inner);
        q = inner.next;
      }
      p = child.next;
    } else if (child.id === TRACKS) {
      for (let q = child.start; q < child.end;) {
        const entry = element(b, q, child.end);
        if (entry.id === TRACK_ENTRY) {
          let number = 0;
          let type = 0;
          let codec = "";
          for (let r = entry.start; r < entry.end;) {
            const field = element(b, r, entry.end);
            if (field.id === TRACK_NUMBER) number = uint(b, field);
            if (field.id === TRACK_TYPE) type = uint(b, field);
            if (field.id === CODEC_ID) codec = text(b, field);
            r = field.next;
          }
          if (type === 2) audioTracks.set(number, codec);
        }
        q = entry.next;
      }
      p = child.next;
    } else if (child.id === CLUSTER) {
      p = clusterChildren(child.start, child.end, child.unknown);
    } else if (child.unknown) throw unreadable();
    else p = child.next;
  }

  if (!scale || scale > 1_000_000_000) throw unreadable();
  const opusTracks = [...audioTracks]
    .filter(([, codec]) => codec === "A_OPUS")
    .map(([n]) => n);
  if (opusTracks.length !== 1 || audioTracks.size !== 1) throw unreadable();
  const track = opusTracks[0]!;
  const own = blocks.filter((x) => x.track === track);
  if (!own.length) throw unreadable();
  let packetMs = 0;
  let first = Infinity;
  let last = -Infinity;
  let lastMs = 0;
  for (const x of own) {
    const ms = opusPacketMs(x.packet);
    packetMs += ms;
    const at = ((x.cluster + x.relative) * scale) / 1_000_000;
    if (at < first) first = at;
    if (at >= last) {
      last = at;
      lastMs = ms;
    }
  }
  const timestampSeconds = (last - first + lastMs) / 1000;
  const infoTotal =
    Number.isFinite(infoSeconds) && infoSeconds > 0
      ? (infoSeconds * scale) / 1e9
      : 0;
  return Math.max(packetMs / 1000, timestampSeconds, infoTotal);
}

// ----------------------------------------------------------------- MP4 ----

type Box = { type: string; start: number; end: number; next: number };

function boxes(
  b: Uint8Array,
  view: DataView,
  from: number,
  to: number,
  counter: { n: number },
) {
  const out: Box[] = [];
  let p = from;
  while (p + 8 <= to) {
    if (++counter.n > 100_000) throw unreadable();
    let size = view.getUint32(p);
    const type = String.fromCharCode(
      b[p + 4]!,
      b[p + 5]!,
      b[p + 6]!,
      b[p + 7]!,
    );
    let header = 8;
    if (size === 1) {
      if (p + 16 > to) throw unreadable();
      const high = view.getUint32(p + 8);
      const low = view.getUint32(p + 12);
      size = high * 2 ** 32 + low;
      header = 16;
    } else if (size === 0) size = to - p;
    if (size < header) throw unreadable();
    let end = p + size;
    if (end > to) {
      // Only the media data may run to the end of a recording.
      if (type !== "mdat") throw unreadable();
      end = to;
    }
    out.push({ type, start: p + header, end, next: end });
    p = end;
  }
  if (p !== to && to - p >= 8) throw unreadable();
  return out;
}

const ALL_ONES_32 = 0xffffffff;

function mp4Duration(b: Uint8Array): number {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const counter = { n: 0 };
  const top = boxes(b, view, 0, b.length, counter);
  if (top[0]?.type !== "ftyp") throw unreadable();
  const child = (box: Box, type: string) =>
    boxes(b, view, box.start, box.end, counter).find((x) => x.type === type);
  const children = (box: Box, type: string) =>
    boxes(b, view, box.start, box.end, counter).filter((x) => x.type === type);
  const need = (box: Box, length: number) => {
    if (box.end - box.start < length) throw unreadable();
  };

  /** Timescale and duration of an mvhd or mdhd box; all-ones durations are unknown. */
  function header(box: Box) {
    need(box, 4);
    const version = b[box.start]!;
    if (version === 1) {
      need(box, 32);
      const timescale = view.getUint32(box.start + 20);
      const high = view.getUint32(box.start + 24);
      const low = view.getUint32(box.start + 28);
      const unknown = high === ALL_ONES_32 && low === ALL_ONES_32;
      return { timescale, duration: unknown ? 0 : high * 2 ** 32 + low };
    }
    need(box, 20);
    const timescale = view.getUint32(box.start + 12);
    const duration = view.getUint32(box.start + 16);
    return { timescale, duration: duration === ALL_ONES_32 ? 0 : duration };
  }

  const moov = top.find((x) => x.type === "moov");
  if (!moov) throw unreadable();
  const mvhdBox = child(moov, "mvhd");
  const mvhd = mvhdBox ? header(mvhdBox) : { timescale: 0, duration: 0 };

  type Track = {
    id: number;
    timescale: number;
    duration: number;
    sttsTicks: number;
    samples: number;
    sampleRate: number;
    aac: boolean;
  };
  let audio: Track | null = null;
  for (const trak of children(moov, "trak")) {
    const tkhd = child(trak, "tkhd");
    const mdia = child(trak, "mdia");
    if (!tkhd || !mdia) continue;
    need(tkhd, 24);
    const id = view.getUint32(tkhd.start + (b[tkhd.start] === 1 ? 20 : 12));
    const hdlr = child(mdia, "hdlr");
    if (!hdlr) continue;
    need(hdlr, 12);
    const handler = String.fromCharCode(
      ...b.subarray(hdlr.start + 8, hdlr.start + 12),
    );
    if (handler !== "soun") continue;
    if (audio) throw unreadable(); // one audio track only
    const mdhdBox = child(mdia, "mdhd");
    if (!mdhdBox) throw unreadable();
    const mdhd = header(mdhdBox);
    const track: Track = {
      id,
      ...mdhd,
      sttsTicks: 0,
      samples: 0,
      sampleRate: 0,
      aac: false,
    };
    const stbl = (() => {
      const minf = child(mdia, "minf");
      return minf ? child(minf, "stbl") : undefined;
    })();
    if (stbl) {
      const stsd = child(stbl, "stsd");
      if (stsd && stsd.end - stsd.start >= 8 + 36) {
        const entry = stsd.start + 8;
        const format = String.fromCharCode(...b.subarray(entry + 4, entry + 8));
        track.aac = format === "mp4a";
        // AudioSampleEntry: sample rate as 16.16 fixed point at offset 32.
        track.sampleRate = view.getUint32(entry + 32) / 65536;
      }
      const stts = child(stbl, "stts");
      if (stts) {
        need(stts, 8);
        const count = view.getUint32(stts.start + 4);
        if (stts.start + 8 + count * 8 > stts.end) throw unreadable();
        for (let i = 0; i < count; i++)
          track.sttsTicks +=
            view.getUint32(stts.start + 8 + i * 8) *
            view.getUint32(stts.start + 12 + i * 8);
      }
      const stsz = child(stbl, "stsz");
      if (stsz) {
        need(stsz, 12);
        track.samples += view.getUint32(stsz.start + 8);
      }
    }
    audio = track;
  }
  if (!audio) throw unreadable();
  const track: Track = audio;

  // Fragmented recordings (MediaRecorder): defaults from trex, runs in moof.
  let trexDuration = 0;
  const mvex = child(moov, "mvex");
  if (mvex)
    for (const trex of children(mvex, "trex")) {
      need(trex, 24);
      if (view.getUint32(trex.start + 4) === track.id)
        trexDuration = view.getUint32(trex.start + 12);
    }
  let fragmentTicks = 0;
  for (const moof of top.filter((x) => x.type === "moof"))
    for (const traf of children(moof, "traf")) {
      const tfhd = child(traf, "tfhd");
      if (!tfhd) throw unreadable();
      need(tfhd, 8);
      const flags = view.getUint32(tfhd.start) & 0xffffff;
      if (view.getUint32(tfhd.start + 4) !== track.id) continue;
      let at = tfhd.start + 8;
      if (flags & 0x01) at += 8;
      if (flags & 0x02) at += 4;
      let defaultDuration = trexDuration;
      if (flags & 0x08) {
        if (at + 4 > tfhd.end) throw unreadable();
        defaultDuration = view.getUint32(at);
      }
      for (const trun of children(traf, "trun")) {
        need(trun, 8);
        const runFlags = view.getUint32(trun.start) & 0xffffff;
        const count = view.getUint32(trun.start + 4);
        let q = trun.start + 8;
        if (runFlags & 0x01) q += 4;
        if (runFlags & 0x04) q += 4;
        const per =
          (runFlags & 0x100 ? 4 : 0) +
          (runFlags & 0x200 ? 4 : 0) +
          (runFlags & 0x400 ? 4 : 0) +
          (runFlags & 0x800 ? 4 : 0);
        if (q + count * per > trun.end) throw unreadable();
        track.samples += count;
        if (runFlags & 0x100)
          for (let i = 0; i < count; i++)
            fragmentTicks += view.getUint32(q + i * per);
        else fragmentTicks += count * defaultDuration;
      }
    }

  const perScale = (ticks: number, timescale: number) =>
    timescale > 0 ? ticks / timescale : 0;
  const frames =
    track.aac && track.sampleRate >= 8000
      ? (track.samples * 1024) / track.sampleRate
      : 0;
  return Math.max(
    perScale(mvhd.duration, mvhd.timescale),
    perScale(track.duration, track.timescale),
    perScale(track.sttsTicks, track.timescale),
    perScale(fragmentTicks, track.timescale),
    frames,
  );
}
