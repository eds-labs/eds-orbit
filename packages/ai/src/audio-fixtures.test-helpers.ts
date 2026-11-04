import type { SpeechProvider } from "./speech.ts";

// Synthetic recordings for the duration and voice tests (ADR 0024): minimal
// WebM/Opus and MP4/AAC containers built byte by byte, so no audio file is
// checked in and no real voice is ever involved. The payload bytes are
// arbitrary; only the container structure and Opus TOC bytes matter.

const bytes = (...parts: Array<Uint8Array | number[]>) => {
  const arrays = parts.map((p) =>
    p instanceof Uint8Array ? p : Uint8Array.from(p),
  );
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
};
const ascii = (value: string) =>
  Uint8Array.from([...value].map((c) => c.charCodeAt(0)));

// ---------------------------------------------------------------- EBML ----

function idBytes(id: number) {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return out;
}
/** An 8-byte EBML size, or the "unknown size" marker. */
function sizeBytes(size: number | "unknown") {
  if (size === "unknown")
    return [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  const out = [0x01];
  for (let i = 6; i >= 0; i--) out.push(Math.floor(size / 256 ** i) & 0xff);
  return out;
}
const ebml = (
  id: number,
  payload: Uint8Array,
  size: number | "unknown" = payload.length,
) => bytes(idBytes(id), sizeBytes(size), payload);
const ebmlUint = (id: number, value: number) => {
  const out: number[] = [];
  for (let v = value; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return ebml(id, Uint8Array.from(out.length ? out : [0]));
};
const ebmlFloat = (id: number, value: number) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return ebml(id, new Uint8Array(view.buffer));
};

/** One Opus packet: TOC 0xF8 is CELT fullband 20 ms, one frame. */
const OPUS_20MS = [0xf8, 0x01, 0x02, 0x03];

/**
 * A MediaRecorder-like WebM: unknown-size segment and clusters, no Info
 * duration (unless `infoDurationMs`), Opus blocks every 20 ms. `timestampScale`
 * multiplies the block timestamps (to fake shortened timestamps).
 */
export function webmRecording(
  seconds: number,
  options: {
    infoDurationMs?: number;
    timestampScale?: number;
    codec?: string;
    laced?: boolean;
    payload?: Uint8Array;
  } = {},
) {
  const header = ebml(
    0x1a45dfa3,
    bytes(
      ebmlUint(0x4286, 1),
      ebml(0x4282, ascii("webm")),
      ebmlUint(0x4287, 4),
      ebmlUint(0x4285, 2),
    ),
  );
  const info = ebml(
    0x1549a966,
    bytes(
      ebmlUint(0x2ad7b1, 1_000_000),
      ...(options.infoDurationMs !== undefined
        ? [ebmlFloat(0x4489, options.infoDurationMs)]
        : []),
    ),
  );
  const tracks = ebml(
    0x1654ae6b,
    ebml(
      0xae,
      bytes(
        ebmlUint(0xd7, 1),
        ebmlUint(0x83, 2),
        ebml(0x86, ascii(options.codec ?? "A_OPUS")),
      ),
    ),
  );
  const clusters: Uint8Array[] = [];
  const packets = Math.round((seconds * 1000) / 20);
  const scale = options.timestampScale ?? 1;
  for (let start = 0; start < packets; start += 100) {
    const blocks: Uint8Array[] = [];
    for (let i = start; i < Math.min(packets, start + 100); i++) {
      const relative = Math.round((i - start) * 20 * scale);
      blocks.push(
        ebml(
          0xa3,
          bytes(
            [
              0x81,
              (relative >> 8) & 0xff,
              relative & 0xff,
              options.laced ? 0x82 : 0x80,
            ],
            options.payload ? bytes([0xf8], options.payload) : OPUS_20MS,
          ),
        ),
      );
    }
    clusters.push(
      ebml(
        0x1f43b675,
        bytes(ebmlUint(0xe7, Math.round(start * 20 * scale)), ...blocks),
        "unknown",
      ),
    );
  }
  const segment = bytes(
    idBytes(0x18538067),
    sizeBytes("unknown"),
    info,
    tracks,
    ...clusters,
  );
  return bytes(header, segment);
}

// ----------------------------------------------------------------- MP4 ----

const u32 = (v: number) => [
  (v >>> 24) & 0xff,
  (v >>> 16) & 0xff,
  (v >>> 8) & 0xff,
  v & 0xff,
];
const u16 = (v: number) => [(v >>> 8) & 0xff, v & 0xff];
const box = (type: string, ...payload: Array<Uint8Array | number[]>) => {
  const body = bytes(...payload);
  return bytes(u32(body.length + 8), ascii(type), body);
};
const full = (
  type: string,
  version: number,
  flags: number,
  ...payload: Array<Uint8Array | number[]>
) =>
  box(
    type,
    [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff],
    ...payload,
  );

/**
 * A Safari-like AAC recording at 48 kHz: either a plain file (sample table)
 * or a fragmented one (moof/trun) with zero header durations.
 * `headerSeconds` overrides the stated durations (to fake a short header).
 */
export function mp4Recording(
  seconds: number,
  options: {
    fragmented?: boolean;
    headerSeconds?: number;
    noAudioTrack?: boolean;
  } = {},
) {
  const rate = 48_000;
  const frames = Math.round((seconds * rate) / 1024);
  const stated = Math.round((options.headerSeconds ?? seconds) * rate);
  const ftyp = box("ftyp", ascii("isom"), u32(512), ascii("isomiso2mp41"));
  const mvhd = full(
    "mvhd",
    0,
    0,
    u32(0),
    u32(0),
    u32(rate),
    u32(options.fragmented ? 0 : stated),
    new Uint8Array(80),
  );
  const tkhd = full(
    "tkhd",
    0,
    3,
    u32(0),
    u32(0),
    u32(1),
    u32(0),
    u32(0),
    new Uint8Array(64),
  );
  const mdhd = full(
    "mdhd",
    0,
    0,
    u32(0),
    u32(0),
    u32(rate),
    u32(options.fragmented ? 0 : stated),
    u16(0),
    u16(0),
  );
  const hdlr = full(
    "hdlr",
    0,
    0,
    u32(0),
    ascii(options.noAudioTrack ? "vide" : "soun"),
    new Uint8Array(12),
    [0],
  );
  const mp4a = box(
    "mp4a",
    new Uint8Array(6),
    u16(1),
    u16(0),
    u16(0),
    u32(0),
    u16(1),
    u16(16),
    u16(0),
    u16(0),
    u32(rate * 65536),
  );
  const stsd = full("stsd", 0, 0, u32(1), mp4a);
  const statedFrames = Math.round(stated / 1024);
  const stts = options.fragmented
    ? full("stts", 0, 0, u32(0))
    : full("stts", 0, 0, u32(1), u32(statedFrames), u32(1024));
  const stsz = full(
    "stsz",
    0,
    0,
    u32(10),
    u32(options.fragmented ? 0 : frames),
  );
  const stbl = box("stbl", stsd, stts, stsz);
  const trak = box("trak", tkhd, box("mdia", mdhd, hdlr, box("minf", stbl)));
  const mvex = box(
    "mvex",
    full("trex", 0, 0, u32(1), u32(1), u32(1024), u32(0), u32(0)),
  );
  const moov = box("moov", mvhd, trak, ...(options.fragmented ? [mvex] : []));
  if (!options.fragmented)
    return bytes(ftyp, moov, box("mdat", new Uint8Array(frames * 4)));
  const fragments: Uint8Array[] = [];
  for (let start = 0; start < frames; start += 50) {
    const count = Math.min(50, frames - start);
    const tfhd = full("tfhd", 0, 0x020000, u32(1));
    const durations = options.headerSeconds !== undefined ? 1 : 1024;
    const trun = full(
      "trun",
      0,
      0x000300,
      u32(count),
      ...Array.from({ length: count }, () => bytes(u32(durations), u32(4))),
    );
    fragments.push(
      box(
        "moof",
        full("mfhd", 0, 0, u32(start / 50 + 1)),
        box("traf", tfhd, trun),
      ),
    );
    fragments.push(box("mdat", new Uint8Array(count * 4)));
  }
  return bytes(ftyp, moov, ...fragments);
}

/** The fake speech adapter of the contract and API tests; never a network call. */
export function fakeSpeechProvider(text = "fake transcript"): SpeechProvider {
  return {
    provider: "openai",
    async transcribe() {
      return { text, durationSeconds: 1 };
    },
    async synthesize(input) {
      return {
        characters: input.text.length,
        mime: "audio/mpeg",
        audio: (async function* () {
          yield Uint8Array.from([0xff, 0xfb, 0x90]);
        })(),
      };
    },
  };
}
