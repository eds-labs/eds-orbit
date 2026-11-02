"use client";
import { socialPath, type SocialPlatform } from "../api";
import { socialText } from "../labels";
import { textHint } from "./limits";

// How a variant will look on its platform (S4): the account, the text cut
// where the platform would cut it, the images, and the used characters.

export function Preview({
  projectId,
  platform,
  handle,
  text,
  media,
  xLongPosts,
  locale,
}: {
  projectId: string;
  platform: SocialPlatform;
  handle: string;
  text: string;
  media: Array<{ mediaId: string; altText: string | null }>;
  xLongPosts?: boolean;
  locale: "en" | "de";
}) {
  const all = socialText(locale);
  const t = all.posts;
  const hint = textHint(platform, text, { xLongPosts, hasMedia: media.length > 0 });
  const shown = hint.over ? [...text].slice(0, hint.limit).join("") : text;
  return (
    <figure className="work-settings-row" aria-label={`${t.preview}: ${all.platform[platform]} ${handle}`}>
      <figcaption>
        <strong>{handle}</strong> <span>{all.platform[platform]}</span>
      </figcaption>
      <p style={{ whiteSpace: "pre-wrap" }}>
        {shown}
        {hint.over && (
          <>
            <mark>…</mark> <span className="field-hint">{t.cut}</span>
          </>
        )}
      </p>
      {media.length > 0 && (
        <div className="settings-rows">
          {media.map((m) => (
            <img
              key={m.mediaId}
              src={`/api${socialPath(projectId, `/media/${m.mediaId}/content?rendition=jpeg`)}`}
              alt={m.altText ?? ""}
              width={120}
              loading="lazy"
            />
          ))}
        </div>
      )}
      <p className="field-hint">{t.limit(all.platform[platform], hint.used, hint.limit)}</p>
    </figure>
  );
}
