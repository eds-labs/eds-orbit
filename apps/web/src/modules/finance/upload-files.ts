import { ApiError } from "@/lib/api";
import type { FinanceText } from "./labels";

// The review page's upload control, without React: which files are offered
// to the server, what a failure or a duplicate answer says, and the
// sequential upload loop.

const EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "webp", "xml"];
const TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/xml",
  "text/xml",
];

/** The file picker's `accept` value. */
export const ACCEPT = [...TYPES, ...EXTENSIONS.map((e) => `.${e}`)].join(",");

/** True for a PDF, PNG, JPEG, WebP or XML file (by type, else by extension). */
export function isAcceptedFile(file: Pick<File, "name" | "type">): boolean {
  if (TYPES.includes(file.type.toLowerCase())) return true;
  // Some browsers report no type for XML; the name decides then.
  if (file.type && file.type !== "application/octet-stream") return false;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return file.name.includes(".") && EXTENSIONS.includes(ext);
}

export type UploadState =
  | { status: "pending" }
  | { status: "done"; duplicate: boolean }
  | { status: "error"; message: string };

export type UploadItem = { key: number; name: string; state: UploadState };

/** The readable text of a failed upload. */
export function uploadErrorText(error: unknown, t: FinanceText): string {
  const u = t.upload;
  if (error instanceof ApiError)
    return (
      u.errors[error.code] ??
      (error.status === 413 ? u.errors.FILE_TOO_LARGE! : u.failed)
    );
  return u.failed;
}

/**
 * Uploads the files one after another. `update` receives every state change
 * by file key; a failed file does not stop the ones after it.
 */
export async function uploadAll(
  files: readonly { key: number; file: File }[],
  upload: (file: File) => Promise<unknown>,
  update: (key: number, state: UploadState) => void,
  t: FinanceText,
): Promise<void> {
  for (const { key, file } of files) {
    update(key, { status: "pending" });
    try {
      const result = (await upload(file)) as { status?: string } | null;
      update(key, {
        status: "done",
        duplicate: result?.status === "duplicate",
      });
    } catch (error) {
      update(key, { status: "error", message: uploadErrorText(error, t) });
    }
  }
}
