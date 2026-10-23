"use client";
import { useRef, useState } from "react";
import { useWorkspace } from "@/components/workspace-context";
import { Badge } from "@/components/ui/primitives";
import { financeApi } from "./api";
import { useFinanceAccess } from "./access";
import { financeText, type FinanceText } from "./labels";
import {
  ACCEPT,
  isAcceptedFile,
  uploadAll,
  type UploadItem,
  type UploadState,
} from "./upload-files";

// Manual upload on the review page (spec §9): a file picker and drop zone for
// receipts; each file goes to the server in turn and shows its own state.
// Only members with finance.write see it; the API stays authoritative.

/** The upload list and drop zone, without data access (rendered in tests). */
export function UploadPanel({
  t,
  items,
  busy,
  onFiles,
}: {
  t: FinanceText;
  items: readonly UploadItem[];
  busy: boolean;
  onFiles: (files: File[]) => void;
}) {
  const u = t.upload;
  const [over, setOver] = useState(false);
  const stateText = (s: UploadState) =>
    s.status === "pending"
      ? u.pending
      : s.status === "done"
        ? s.duplicate
          ? u.duplicate
          : u.done
        : s.message;
  return (
    <div
      className="finance-upload"
      data-over={over ? "true" : undefined}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onFiles(Array.from(e.dataTransfer?.files ?? []));
      }}
    >
      <label>
        <span>{u.title}</span>
        <input
          type="file"
          multiple
          accept={ACCEPT}
          aria-label={u.choose}
          disabled={busy}
          onChange={(e) => {
            onFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </label>
      <small className="field-hint">
        {u.drop} {u.hint}
      </small>
      {items.length > 0 && (
        <ul className="settings-rows" aria-label={u.list} aria-live="polite">
          {items.map((item) => (
            <li key={item.key} className="finance-upload-item">
              <span className="list-row-title">{item.name}</span>{" "}
              <Badge
                tone={
                  item.state.status === "error"
                    ? "danger"
                    : item.state.status === "done"
                      ? "success"
                      : "neutral"
                }
              >
                {stateText(item.state)}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The review page's upload control; renders nothing without finance.write. */
export function FinanceUpload({ onUploaded }: { onUploaded: () => void }) {
  const { project, locale } = useWorkspace();
  const { write } = useFinanceAccess();
  const t = financeText(locale);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const next = useRef(0);
  if (!write) return null;
  const files = financeApi(project.id);

  async function onFiles(chosen: File[]) {
    // One batch at a time: a double submit cannot post a file twice.
    if (lock.current || chosen.length === 0) return;
    lock.current = true;
    setBusy(true);
    const accepted: { key: number; file: File }[] = [];
    const rows: UploadItem[] = chosen.map((file) => {
      const key = next.current++;
      const ok = isAcceptedFile(file);
      if (ok) accepted.push({ key, file });
      return {
        key,
        name: file.name,
        state: ok
          ? { status: "pending" }
          : { status: "error", message: t.upload.skipped },
      };
    });
    setItems(rows);
    try {
      await uploadAll(
        accepted,
        (file) => files.documents.upload(file),
        (key, state) =>
          setItems((list) =>
            list.map((i) => (i.key === key ? { ...i, state } : i)),
          ),
        t,
      );
    } finally {
      lock.current = false;
      setBusy(false);
      onUploaded();
    }
  }
  return <UploadPanel t={t} items={items} busy={busy} onFiles={onFiles} />;
}
