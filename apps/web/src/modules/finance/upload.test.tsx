import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "@/lib/api";
import { financeText } from "./labels";
import {
  ACCEPT,
  isAcceptedFile,
  uploadAll,
  uploadErrorText,
  type UploadState,
} from "./upload-files";
import { UploadPanel } from "./upload";

const t = financeText("en");
const file = (name: string, type: string) => ({ name, type });

describe("isAcceptedFile", () => {
  it("accepts PDF, PNG, JPEG, WebP and XML", () => {
    for (const f of [
      file("a.pdf", "application/pdf"),
      file("a.png", "image/png"),
      file("a.jpg", "image/jpeg"),
      file("a.webp", "image/webp"),
      file("a.xml", "application/xml"),
      file("a.xml", ""),
      file("SCAN.PDF", "application/octet-stream"),
    ])
      expect(isAcceptedFile(f), f.name).toBe(true);
  });
  it("refuses everything else, whatever the name says", () => {
    for (const f of [
      file("a.exe", "application/x-msdownload"),
      file("a.zip", "application/zip"),
      file("noext", ""),
      file("a.pdf", "text/html"),
      file("a.txt", ""),
    ])
      expect(isAcceptedFile(f), f.name).toBe(false);
    expect(ACCEPT).toContain("application/pdf");
  });
});

describe("uploadAll", () => {
  const f = (name: string) =>
    new File(["x"], name, { type: "application/pdf" });
  it("uploads one file after another and maps a 413 to a readable text", async () => {
    const order: string[] = [];
    const upload = vi.fn(async (file: File) => {
      order.push(file.name);
      if (file.name === "big.pdf") throw new ApiError("SOMETHING", 413);
      if (file.name === "dup.pdf") return { status: "duplicate" };
      return { status: "needs_review" };
    });
    const states = new Map<number, UploadState>();
    await uploadAll(
      [
        { key: 1, file: f("big.pdf") },
        { key: 2, file: f("dup.pdf") },
        { key: 3, file: f("ok.pdf") },
      ],
      upload,
      (key, state) => states.set(key, state),
      t,
    );
    expect(order).toEqual(["big.pdf", "dup.pdf", "ok.pdf"]);
    expect(states.get(1)).toEqual({
      status: "error",
      message: t.upload.errors.FILE_TOO_LARGE,
    });
    expect(states.get(2)).toEqual({ status: "done", duplicate: true });
    expect(states.get(3)).toEqual({ status: "done", duplicate: false });
  });
  it("maps known codes in both languages", () => {
    for (const locale of ["en", "de"] as const) {
      const text = financeText(locale);
      for (const code of [
        "FILE_TOO_LARGE",
        "FILE_TYPE_NOT_ALLOWED",
        "FINANCE_DOCUMENT_TYPE_UNSUPPORTED",
        "FILES_QUOTA_EXCEEDED",
      ])
        expect(uploadErrorText(new ApiError(code, 415), text)).toBe(
          text.upload.errors[code],
        );
    }
    expect(uploadErrorText(new Error("boom"), t)).toBe(t.upload.failed);
  });
});

describe("UploadPanel", () => {
  it("renders file names as text, with their state", () => {
    const html = renderToStaticMarkup(
      <UploadPanel
        t={t}
        busy={false}
        onFiles={() => {}}
        items={[
          {
            key: 1,
            name: "<img src=x onerror=1>.pdf",
            state: { status: "pending" },
          },
          { key: 2, name: "b.pdf", state: { status: "done", duplicate: true } },
        ]}
      />,
    );
    expect(html).toContain("&lt;img src=x onerror=1&gt;.pdf");
    expect(html).not.toContain("<img");
    expect(html).toContain(t.upload.duplicate);
    expect(html).toContain('type="file"');
  });
});
