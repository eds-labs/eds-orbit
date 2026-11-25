const box = (type: string, ...parts: Buffer[]) => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(parts.reduce((length, part) => length + part.length, 8));
  header.write(type, 4, "ascii");
  return Buffer.concat([header, ...parts]);
};

/** Minimal ISO BMFF metadata with one video track. No sample decoder is needed. */
export function videoFixture({
  width = 540,
  height = 960,
  duration = 1200,
  codec = "avc1",
} = {}) {
  const time = Buffer.alloc(20);
  time.writeUInt32BE(1000, 12);
  time.writeUInt32BE(duration, 16);
  const handler = Buffer.alloc(12);
  handler.write("vide", 8);
  const header = Buffer.alloc(78);
  header.writeUInt16BE(width, 24);
  header.writeUInt16BE(height, 26);
  const entries = Buffer.alloc(8);
  entries.writeUInt32BE(1, 4);
  const sample = box(
    codec,
    header,
    box("avcC", Buffer.from([1, 66, 0, 30, 255, 225, 1])),
  );
  const table = box("stbl", box("stsd", entries, sample));
  return Buffer.concat([
    box("ftyp", Buffer.from("isom\0\0\0\0")),
    box(
      "moov",
      box("mvhd", time),
      box(
        "trak",
        box(
          "mdia",
          box("mdhd", time),
          box("hdlr", handler),
          box("minf", table),
        ),
      ),
    ),
    box("mdat", Buffer.from([1, 2, 3])),
  ]);
}
