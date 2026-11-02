"use client";
import { socialPath, type MediaRef, type SocialMedia } from "../api";
import { socialText } from "../labels";

// Choosing library images for a post (S4): in the order they are chosen,
// at most ten. An image the post has but the library no longer lists (it
// was removed while a post used it) stays shown, so it can be taken out.

const MAX = 10;

export function MediaPicker({
  projectId,
  target,
  legend,
  library,
  known = [],
  selected,
  disabled,
  locale,
  onChange,
}: {
  projectId: string;
  /** "base" or an account id; makes the field ids unique. */
  target: string;
  legend: string;
  library: SocialMedia[];
  /** Images the post already has, for those the library no longer lists. */
  known?: MediaRef[];
  selected: string[];
  disabled?: boolean;
  locale: "en" | "de";
  onChange: (ids: string[]) => void;
}) {
  const t = socialText(locale).posts;
  const gone = selected
    .filter((id) => !library.some((m) => m.id === id))
    .map((id) => {
      const ref = known.find((k) => k.mediaId === id);
      return { id, name: t.removedFromLibrary, altText: ref?.altText ?? null };
    });
  const items = [...library.map((m) => ({ id: m.id, name: m.name, altText: m.altText })), ...gone];
  return (
    <fieldset>
      <legend>{legend}</legend>
      {items.length ? (
        <ul className="settings-rows">
          {items.map((m) => {
            const position = selected.indexOf(m.id);
            const id = `social-post-media-${target}-${m.id}`;
            return (
              <li key={m.id}>
                <input
                  id={id}
                  type="checkbox"
                  checked={position >= 0}
                  disabled={disabled || (position < 0 && selected.length >= MAX)}
                  onChange={() =>
                    onChange(position >= 0 ? selected.filter((x) => x !== m.id) : [...selected, m.id])
                  }
                />{" "}
                <label htmlFor={id}>
                  <img
                    src={`/api${socialPath(projectId, `/media/${m.id}/content?rendition=jpeg`)}`}
                    alt={m.altText ?? m.name}
                    width={64}
                    loading="lazy"
                  />{" "}
                  {position >= 0 ? `${position + 1}. ` : ""}
                  {m.name}
                </label>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="field-hint">{t.mediaEmpty}</p>
      )}
    </fieldset>
  );
}
