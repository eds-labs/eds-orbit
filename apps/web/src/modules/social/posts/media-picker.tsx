"use client";
import { socialPath, type SocialMedia } from "../api";
import { socialText } from "../labels";

// Choosing library images for a post (S4): in the order they are chosen,
// at most ten.

const MAX = 10;

export function MediaPicker({
  projectId,
  target,
  legend,
  library,
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
  selected: string[];
  disabled?: boolean;
  locale: "en" | "de";
  onChange: (ids: string[]) => void;
}) {
  const t = socialText(locale).posts;
  return (
    <fieldset>
      <legend>{legend}</legend>
      {library.length ? (
        <ul className="settings-rows">
          {library.map((m) => {
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
