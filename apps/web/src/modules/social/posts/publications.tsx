"use client";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Alert, Badge, Button, Modal } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
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
          const reason = p.blockedCode ?? (p.status === "failed" ? p.lastErrorCode : null);
          return (
            <li key={p.id} className="work-settings-row">
              <div>
                <strong>{handleOf(p.accountId)}</strong> <span className="field-hint">{all.platform[p.platform]}</span>{" "}
                <Badge tone={tone(p.status)}>{t.status[p.status] ?? p.status}</Badge> {p.test && <Badge>{t.test}</Badge>}
                {p.permalink && (
                  <p>
                    <a href={p.permalink} target="_blank" rel="noreferrer">
                      {t.open}
                    </a>
                  </p>
                )}
                {reason && <p className="field-hint">{publicationReason(reason, locale)}</p>}
                {p.status === "outcome_unknown" && <p className="field-hint">{t.unknownHelp}</p>}
              </div>
              {p.status === "outcome_unknown" && isOwner && (
                <div>
                  <Button size="sm" variant="outline" onClick={() => setSettling({ publication: p, resolution: "published_confirmed" })}>
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
          <Button variant="outline" onClick={() => setSettling(null)}>
            {t.keep}
          </Button>{" "}
          <Button
            onClick={async () => {
              try {
                await api(socialPath(project.id, `/publications/${settling.publication.id}/resolve`), {
                  method: "POST",
                  body: JSON.stringify({ resolution: settling.resolution, version: settling.publication.version }),
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
