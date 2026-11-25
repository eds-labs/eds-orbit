"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Alert, Badge, Button, Field, FieldLabel, Input, Modal } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { channelCopy } from "../channels-copy";
import { socialPath, type PostView, type PublicationView } from "../api";
import { postMessage, publicationReason, socialText } from "../labels";

// The deliveries of a post (ADR 0020, S5): one row per account with its
// state, its link once published, the reason when it was held back, and for
// an unclear send the owner's two answers. Orbit never resends by itself.

const tone = (status: string) =>
  status === "published" ? "success" : status === "outcome_unknown" || status === "blocked" || status === "failed" ? "warning" : "neutral";

export function Publications({ post, onChanged }: { post: PostView; onChanged: () => void }) {
  const { project, locale, isOwner, canEdit } = useWorkspace();
  const all = socialText(locale);
  const t = all.publications;
  const channel = channelCopy(locale);
  const [permalink, setPermalink] = useState("");
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [settling, setSettling] = useState<{ publication: PublicationView; resolution: "published_confirmed" | "not_published" } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const publications = post.publications ?? [];
  if (!publications.length) return null;
  const handleOf = (accountId: string) => post.variants.find((v) => v.accountId === accountId)?.handle ?? accountId;
  return (
    <section aria-label={t.title}>
      <h2>{t.title}</h2>
      {message && <Alert kind="error">{message}</Alert>}
      <ul className="settings-rows">
        {publications.map((p) => {
          const manual = p.platform === "tiktok" && p.blockedCode === "SOCIAL_TIKTOK_MANUAL_REQUIRED";
          const variant = manual ? post.variants.find((v) => v.accountId === p.accountId) : undefined;
          const reason = p.blockedCode ?? (p.status === "failed" ? p.lastErrorCode : null);
          return (
            <li key={p.id} className="work-settings-row">
              <div>
                <strong>{handleOf(p.accountId)}</strong> <span className="field-hint">{all.platform[p.platform]}</span>{" "}
                <Badge tone={tone(p.status)}>{manual ? channel.tiktokOpen : t.status[p.status] ?? p.status}</Badge> {p.test && <Badge>{t.test}</Badge>}
                {p.permalink && (
                  <p>
                    <a href={p.permalink} target="_blank" rel="noreferrer">
                      {t.open}
                    </a>
                  </p>
                )}
                {reason && !manual && <p className="field-hint">{publicationReason(reason, locale)}</p>}
                {p.status === "outcome_unknown" && <p className="field-hint">{t.unknownHelp}</p>}
              </div>
              {manual && isOwner && !post.readOnly && variant && (
                <div>
                  {p.inboxReady && <p>{channel.inboxReady}</p>}
                  <p>{channel.tiktokNext}</p>
                  {variant.media.map((media) => (
                    <p key={media.mediaId}>
                      <a href={`/api${socialPath(project.id, `/media/${media.mediaId}/content?download=1`)}`} download>{channel.download}</a>
                    </p>
                  ))}
                  {variant.body && (
                    <>
                      <p style={{ whiteSpace: "pre-wrap" }}>{variant.body}</p>
                      <Button size="sm" variant="outline" onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(variant.body);
                          setCopyNotice(channel.captionCopied);
                        } catch {
                          setCopyNotice(channel.copyFailed);
                        }
                      }}>{channel.copyCaption}</Button>
                      {copyNotice && <p role="status">{copyNotice}</p>}
                    </>
                  )}
                </div>
              )}
              {/* History mirrored from Postiz (S10) is shown, never settled here. */}
              {(p.status === "outcome_unknown" || manual) && isOwner && !post.readOnly && (
                <div>
                  <Button size="sm" variant="outline" onClick={() => { setPermalink(""); setSettling({ publication: p, resolution: "published_confirmed" }); }}>
                    {t.published}
                  </Button>{" "}
                  <Button size="sm" variant="outline" onClick={() => setSettling({ publication: p, resolution: "not_published" })}>
                    {t.notPublished}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {post.status === "publishing" && canEdit && (
        <Button
          variant="outline"
          onClick={async () => {
            try {
              await api(socialPath(project.id, `/posts/${post.id}/cancel`), { method: "POST", body: JSON.stringify({ version: post.version }) });
              onChanged();
            } catch (e) {
              setMessage(postMessage(e instanceof ApiError ? e.code : "REQUEST_FAILED", locale));
            }
          }}
        >
          {t.stop}
        </Button>
      )}
      {settling && (
        <Modal
          title={t.confirmTitle}
          description={settling.resolution === "published_confirmed" ? t.confirmPublished : t.confirmNot}
          onClose={() => setSettling(null)}
        >
          {settling.publication.platform === "tiktok" && settling.resolution === "published_confirmed" && (
            <Field>
              <FieldLabel htmlFor="social-tiktok-permalink">{channel.permalink}</FieldLabel>
              <Input id="social-tiktok-permalink" type="url" value={permalink} onChange={(e) => setPermalink(e.target.value)} />
            </Field>
          )}
          <Button variant="outline" onClick={() => setSettling(null)}>
            {t.keep}
          </Button>{" "}
          <Button
            disabled={settling.publication.platform === "tiktok" && settling.resolution === "published_confirmed" && !permalink.trim()}
            onClick={async () => {
              try {
                await api(socialPath(project.id, `/publications/${settling.publication.id}/resolve`), {
                  method: "POST",
                  body: JSON.stringify({ resolution: settling.resolution, version: settling.publication.version, ...(permalink.trim() && settling.resolution === "published_confirmed" ? { permalink: permalink.trim() } : {}) }),
                });
                onChanged();
              } catch (e) {
                setMessage(postMessage(e instanceof ApiError ? e.code : "REQUEST_FAILED", locale));
              }
              setSettling(null);
            }}
          >
            {t.confirm}
          </Button>
        </Modal>
      )}
    </section>
  );
}
