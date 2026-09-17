import sanitizeHtml from "sanitize-html";
import { inflateRawSync } from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { KnowledgeError, LIMITS } from "./types.js";
import { normalizeText } from "./algorithms.js";
export const MIME = {
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
function entities(text: string) {
  return text
    .replace(/&#(x[\da-f]+|\d+);/gi, (_match, n: string) => {
      const code =
        n[0]?.toLowerCase() === "x"
          ? Number.parseInt(n.slice(1), 16)
          : Number(n);
      return code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
export function extractHtml(input: string) {
  // Sanitizer parses without executing scripts, loading CSS or making subrequests.
  const cleaned = sanitizeHtml(input, {
    allowedTags: [
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "br",
      "li",
      "table",
      "tr",
      "th",
      "td",
      "pre",
      "blockquote",
    ],
    allowedAttributes: {},
    nonTextTags: [
      "script",
      "style",
      "textarea",
      "option",
      "nav",
      "footer",
      "header",
      "svg",
      "math",
      "iframe",
      "noscript",
      "template",
    ],
  });
  const structured = cleaned.replace(
    /<(th|td)>([\s\S]*?)<\/\1>/g,
    (_m, _tag, content: string) =>
      content
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim() + " | ",
  );
  return normalizeText(
    entities(
      structured
        .replace(/<h([1-6])>/g, (_m, n) => "\n\n" + "#".repeat(Number(n)) + " ")
        .replace(/<\/h[1-6]>/g, "\n\n")
        .replace(/<br\s*\/?>/g, "\n")
        .replace(/<li>/g, "\n- ")
        .replace(/<\/?table>/g, "\n\n")
        .replace(/<\/tr>/g, "\n")
        .replace(/<\/(?:p|pre|blockquote)>/g, "\n\n")
        .replace(/<\/(?:th|td)>/g, " | ")
        .replace(/<[^>]+>/g, ""),
    ),
  );
}
export function validateDocxArchive(bytes: Buffer) {
  // Read central directory sizes before any ZIP decompression; reject ZIP64/encryption.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new KnowledgeError("INVALID_DOCX");
  const count = bytes.readUInt16LE(end + 10),
    offset = bytes.readUInt32LE(end + 16),
    centralSize = bytes.readUInt32LE(end + 12);
  if (
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0 ||
    bytes.readUInt16LE(end + 8) !== count ||
    end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length
  )
    throw new KnowledgeError("INVALID_DOCX");
  if (
    !count ||
    count > 1000 ||
    count === 65535 ||
    offset === 0xffffffff ||
    centralSize === 0xffffffff ||
    offset + centralSize !== end
  )
    throw new KnowledgeError("DOCX_LIMIT");
  let cursor = offset,
    total = 0;
  let hasDocument = false;
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw new KnowledgeError("INVALID_DOCX");
    const flags = bytes.readUInt16LE(cursor + 8),
      compressed = bytes.readUInt32LE(cursor + 20),
      size = bytes.readUInt32LE(cursor + 24),
      nameLength = bytes.readUInt16LE(cursor + 28),
      extra = bytes.readUInt16LE(cursor + 30),
      comment = bytes.readUInt16LE(cursor + 32);
    const name = bytes
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");
    if (
      cursor + 46 + nameLength + extra + comment > end ||
      names.has(name) ||
      name.includes("\\")
    )
      throw new KnowledgeError("INVALID_DOCX");
    names.add(name);
    let extraCursor = cursor + 46 + nameLength;
    const extraEnd = extraCursor + extra;
    while (extraCursor < extraEnd) {
      if (extraCursor + 4 > extraEnd) throw new KnowledgeError("INVALID_DOCX");
      const tag = bytes.readUInt16LE(extraCursor),
        length = bytes.readUInt16LE(extraCursor + 2);
      if (
        tag === 0x0001 ||
        tag === 0x7075 ||
        extraCursor + 4 + length > extraEnd
      )
        throw new KnowledgeError("DOCX_LIMIT");
      extraCursor += 4 + length;
    }
    if (
      flags & 1 ||
      size === 0xffffffff ||
      compressed === 0xffffffff ||
      name.includes("..") ||
      name.startsWith("/") ||
      name.toLowerCase().endsWith("vbaproject.bin") ||
      size > 8_000_000 ||
      size > Math.max(100000, compressed * 100)
    )
      throw new KnowledgeError("DOCX_LIMIT");
    total += size;
    if (total > 12_000_000) throw new KnowledgeError("DOCX_LIMIT");
    const localOffset = bytes.readUInt32LE(cursor + 42),
      method = bytes.readUInt16LE(cursor + 10);
    if (
      ![0, 8].includes(method) ||
      localOffset + 30 > bytes.length ||
      bytes.readUInt32LE(localOffset) !== 0x04034b50
    )
      throw new KnowledgeError("INVALID_DOCX");
    const localNameLength = bytes.readUInt16LE(localOffset + 26),
      localExtra = bytes.readUInt16LE(localOffset + 28),
      dataStart = localOffset + 30 + localNameLength + localExtra;
    if (
      dataStart + compressed > offset ||
      bytes.readUInt16LE(localOffset + 8) !== method ||
      bytes.readUInt16LE(localOffset + 6) !== flags ||
      bytes
        .subarray(localOffset + 30, localOffset + 30 + localNameLength)
        .toString("utf8") !== name
    )
      throw new KnowledgeError("INVALID_DOCX");
    try {
      const compressedBytes = bytes.subarray(dataStart, dataStart + compressed);
      const expanded =
        method === 0
          ? compressedBytes
          : inflateRawSync(compressedBytes, { maxOutputLength: 8_000_001 });
      if (expanded.length !== size || expanded.length > 8_000_000)
        throw new KnowledgeError("DOCX_LIMIT");
      if (/\.(?:xml|rels)$/i.test(name)) {
        const xml = new TextDecoder("utf-8", { fatal: true }).decode(expanded);
        if (xml.includes("\0") || /<!DOCTYPE|<!ENTITY/i.test(xml))
          throw new KnowledgeError("UNSAFE_DOCX_XML");
      }
    } catch {
      throw new KnowledgeError("DOCX_LIMIT");
    }
    if (name === "word/document.xml") hasDocument = true;
    cursor += 46 + nameLength + extra + comment;
  }
  if (cursor !== offset + centralSize || !hasDocument)
    throw new KnowledgeError("INVALID_DOCX");
}
export async function extractDocument(
  bytes: Buffer,
  mimeType: string,
): Promise<{ text: string; extractorVersion: string; pages?: number }> {
  if (!bytes.length || bytes.length > LIMITS.maxBytes)
    throw new KnowledgeError("INVALID_DOCUMENT_SIZE");
  if ([MIME.txt, MIME.md, MIME.html].includes(mimeType)) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new KnowledgeError("INVALID_TEXT_ENCODING");
    }
    if (text.includes("\0")) throw new KnowledgeError("INVALID_TEXT");
    text = mimeType === MIME.html ? extractHtml(text) : normalizeText(text);
    if (!text) throw new KnowledgeError("NO_EXTRACTABLE_TEXT");
    return { text, extractorVersion: "safe-text-v1" };
  }
  if (mimeType === MIME.pdf) {
    if (bytes.subarray(0, 5).toString() !== "%PDF-")
      throw new KnowledgeError("INVALID_PDF");
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--max-old-space-size=96",
          "--max-semi-space-size=4",
          fileURLToPath(new URL("./pdf-worker.mjs", import.meta.url)),
        ],
        {
          stdio: ["pipe", "pipe", "ignore"],
          cwd: tmpdir(),
          env: { NODE_ENV: "production" },
        },
      );
      const output: Buffer[] = [];
      let length = 0;
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new KnowledgeError("PARSER_TIMEOUT"));
      }, 10000);
      timeout.unref();
      child.stdout.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > 4_000_000) {
          child.kill("SIGKILL");
          reject(new KnowledgeError("DOCUMENT_TOO_LARGE"));
        } else output.push(chunk);
      });
      child.on("error", () => {
        clearTimeout(timeout);
        reject(new KnowledgeError("PDF_NOT_EXTRACTABLE"));
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new KnowledgeError("PDF_NOT_EXTRACTABLE"));
          return;
        }
        try {
          const result = JSON.parse(Buffer.concat(output).toString("utf8"));
          if (result.error) reject(new KnowledgeError(result.error));
          else if (typeof result.text === "string")
            resolve({ ...result, text: normalizeText(result.text) });
          else reject(new KnowledgeError("PDF_NOT_EXTRACTABLE"));
        } catch {
          reject(new KnowledgeError("PDF_NOT_EXTRACTABLE"));
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(bytes);
    });
  }
  if (mimeType === MIME.docx) {
    validateDocxArchive(bytes);
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.convertToHtml(
        { buffer: bytes },
        {
          externalFileAccess: false,
          convertImage: mammoth.images.imgElement(() =>
            Promise.resolve({ src: "" }),
          ),
        },
      );
      const text = extractHtml(result.value);
      if (!text) throw new KnowledgeError("NO_EXTRACTABLE_TEXT");
      if (Buffer.byteLength(text) > LIMITS.maxBytes)
        throw new KnowledgeError("DOCUMENT_TOO_LARGE");
      return { text, extractorVersion: "mammoth-1-v1" };
    } catch (e) {
      if (e instanceof KnowledgeError) throw e;
      throw new KnowledgeError("DOCX_NOT_EXTRACTABLE");
    }
  }
  throw new KnowledgeError("UNSUPPORTED_MIME");
}
