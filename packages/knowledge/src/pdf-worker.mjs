// A dedicated parser process receives document bytes only, never application credentials.
// V8 heap and wall time are bounded by the parent; deployment adds container memory limits.
console.log = () => {};
console.warn = () => {};
console.error = () => {};
let size = 0;
const pieces = [];
let task;
try {
  for await (const piece of process.stdin) {
    size += piece.length;
    if (size > 2_000_000) throw new Error("INVALID_DOCUMENT_SIZE");
    pieces.push(piece);
  }
  const bytes = Buffer.concat(pieces);
  if (bytes.subarray(0, 5).toString() !== "%PDF-")
    throw new Error("INVALID_PDF");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  task = getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    maxImageSize: 0,
    stopAtErrors: true,
    verbosity: 0,
  });
  const doc = await task.promise;
  if (doc.numPages > 100) throw new Error("PDF_PAGE_LIMIT");
  const pages = [];
  let chars = 0;
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber),
      content = await page.getTextContent();
    const text = content.items
      .map((item) =>
        "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
      )
      .join("");
    chars += text.length;
    if (chars > 2_000_000) throw new Error("DOCUMENT_TOO_LARGE");
    pages.push("# Page " + pageNumber + "\n\n" + text);
    page.cleanup();
  }
  const text = pages.join("\n\n").trim();
  if (text.replace(/# Page \d+/g, "").trim().length < 3)
    throw new Error("NO_EXTRACTABLE_TEXT");
  process.stdout.write(
    JSON.stringify({
      text,
      extractorVersion: "pdfjs-6-process-v1",
      pages: doc.numPages,
    }),
  );
} catch (e) {
  const codes = [
    "INVALID_DOCUMENT_SIZE",
    "INVALID_PDF",
    "PDF_PAGE_LIMIT",
    "DOCUMENT_TOO_LARGE",
    "NO_EXTRACTABLE_TEXT",
  ];
  process.stdout.write(
    JSON.stringify({
      error: codes.includes(e?.message) ? e.message : "PDF_NOT_EXTRACTABLE",
    }),
  );
} finally {
  await task?.destroy();
}
