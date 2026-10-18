"use client";
import { Plus, Trash2 } from "lucide-react";
import { useResource } from "@/lib/api";
import { Button, Input } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { supportPath } from "./api";
import type { SupportText } from "./labels";

/** The colours a tag can have; the API accepts exactly these. */
export const TAG_COLORS = [
  "gray",
  "blue",
  "green",
  "yellow",
  "orange",
  "red",
  "purple",
  "pink",
] as const;
export type TagColor = (typeof TAG_COLORS)[number];
export type TagDef = { key: string; label: string; color: TagColor };

/** A tag key from its label: lower case, a-z/0-9/_, unique among `taken`. */
export function tagKey(label: string, taken: string[]) {
  let base = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36);
  if (!base) base = "tag";
  if (!/^[a-z]/.test(base)) base = `t_${base}`.slice(0, 36);
  if (base.length < 2) base = `${base}_tag`;
  let key = base;
  for (let n = 2; taken.includes(key); n++) key = `${base}_${n}`;
  return key;
}

const NEW_TAG = "new:";

/**
 * The tag list to save: labels trimmed, empty rows dropped, and rows added
 * in this edit keyed by their final label. Existing keys never change, so
 * tickets keep their tags when a label is renamed.
 */
export function finalizeTags(rows: TagDef[]): TagDef[] {
  const kept = rows
    .map((row) => ({ ...row, label: row.label.trim() }))
    .filter((row) => row.label);
  const taken = kept
    .filter((row) => !row.key.startsWith(NEW_TAG))
    .map((row) => row.key);
  return kept.map((row) => {
    if (!row.key.startsWith(NEW_TAG)) return row;
    const key = tagKey(row.label, taken);
    taken.push(key);
    return { ...row, key };
  });
}

/** One tag as a coloured chip; a tag no longer in the list shows plainly. */
export function TagChip({ tag, defs }: { tag: string; defs: TagDef[] }) {
  const def = defs.find((d) => d.key === tag);
  return (
    <span className="support-tag" data-color={def?.color ?? "gray"}>
      {def?.label ?? tag}
    </span>
  );
}

/** Toggles for every listed tag, plus the unlisted ones the ticket has. */
export function TagPicker({
  defs,
  value,
  onChange,
  t,
  disabled,
}: {
  defs: TagDef[];
  value: string[];
  onChange: (tags: string[]) => void;
  t: SupportText;
  disabled?: boolean;
}) {
  const keys = [
    ...defs.map((d) => d.key),
    ...value.filter((tag) => !defs.some((d) => d.key === tag)),
  ];
  if (!keys.length) return <p className="support-muted">{t.noTagsDefined}</p>;
  return (
    <div className="support-tag-picker" role="group" aria-label={t.tags}>
      {keys.map((key) => {
        const on = value.includes(key);
        return (
          <button
            key={key}
            type="button"
            className="support-tag-toggle"
            aria-pressed={on}
            disabled={disabled}
            onClick={() =>
              onChange(on ? value.filter((v) => v !== key) : [...value, key])
            }
          >
            <TagChip tag={key} defs={defs} />
          </button>
        );
      })}
    </div>
  );
}

/** The owner's tag list in the support settings: label and colour per row. */
export function TagEditor({
  value,
  onChange,
  t,
  disabled,
}: {
  value: TagDef[];
  onChange: (tags: TagDef[]) => void;
  t: SupportText;
  disabled?: boolean;
}) {
  const set = (i: number, patch: Partial<TagDef>) =>
    onChange(value.map((row, j) => (i === j ? { ...row, ...patch } : row)));
  return (
    <fieldset className="support-tag-editor">
      <legend>{t.settings.tags}</legend>
      <p className="support-muted">{t.settings.tagsHint}</p>
      {value.map((row, i) => (
        <div className="support-tag-row" key={row.key}>
          <TagChip tag={row.key} defs={value} />
          <Input
            aria-label={t.settings.tagLabel}
            value={row.label}
            maxLength={40}
            disabled={disabled}
            onChange={(e) => set(i, { label: e.target.value })}
          />
          <select
            aria-label={t.settings.tagColor}
            value={row.color}
            disabled={disabled}
            onChange={(e) => set(i, { color: e.target.value as TagColor })}
          >
            {TAG_COLORS.map((c) => (
              <option key={c} value={c}>
                {t.settings.colors[c]}
              </option>
            ))}
          </select>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            aria-label={`${t.settings.removeTag}: ${row.label}`}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <Trash2 aria-hidden size={14} />
          </Button>
        </div>
      ))}
      {!disabled && value.length < 50 && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            onChange([
              ...value,
              {
                // Keyed by its label when saved (finalizeTags).
                key: `${NEW_TAG}${Date.now()}`,
                label: t.settings.newTag,
                color: TAG_COLORS[value.length % TAG_COLORS.length]!,
              },
            ]);
          }}
        >
          <Plus aria-hidden size={14} /> {t.settings.addTag}
        </Button>
      )}
    </fieldset>
  );
}

/** The project's categories and tags from the support settings (agents may read them). */
export function useSupportLists() {
  const { project } = useWorkspace();
  const settings = useResource<{
    settings: {
      categories: Array<{ key: string; label: string }>;
      tags?: TagDef[];
    };
  }>(supportPath(project.id, "/settings"));
  return {
    categories: settings.data?.settings.categories ?? [],
    tags: settings.data?.settings.tags ?? [],
  };
}
