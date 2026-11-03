"use client";
import type { ActionRequestRenderer } from "@/platform/assistant/extensions";
import { Button } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { socialPath, type MediaRef, type SocialPlatform } from "./api";
import { socialText } from "./labels";

// A social post request in Decisions (ADR 0020, S4): the owner sees
// exactly what the approval covers, per account, and the time.

type Operation = {
  kind: "social_post";
  mode: "at" | "now";
  at: string | null;
  local: string | null;
  timeZone: string;
  variants: Array<{ accountId: string; platform: SocialPlatform; handle: string; body: string; media: MediaRef[] }>;
};

const TEXT = {
  en: {
    at: "Schedule a social post",
    now: "Publish a social post now",
    immediately: "Immediately after approval",
    note: "Approval applies exactly this content and time once.",
    approve: "Approve",
    reject: "Reject",
    verifyTitle: (handle: string) => `Test posting on ${handle}`,
    verifyNote: "This posts publicly on the account. Approval applies exactly this text once; afterwards the account may post live.",
    draftTitle: (change: string, title: string) => `${change === "update" ? "Change a social draft" : "New social draft"}: ${title}`,
    images: (n: number) => `${n} ${n === 1 ? "image" : "images"}`,
    draftNote: "Approval saves exactly this draft. Nothing is published; publishing needs its own approval.",
    cancelTitle: (title: string) => `Take a planned social post back to a draft: ${title}`,
    cancelNote: "Its approval ends. A post that is being sent keeps what already went out.",
    untitled: "Untitled",
  },
  de: {
    at: "Social-Beitrag einplanen",
    now: "Social-Beitrag sofort veröffentlichen",
    immediately: "Sofort nach der Freigabe",
    note: "Die Freigabe gilt genau für diesen Inhalt und diese Zeit.",
    approve: "Freigeben",
    reject: "Ablehnen",
    verifyTitle: (handle: string) => `Testbeitrag auf ${handle}`,
    verifyNote: "Das wird öffentlich auf dem Konto gepostet. Die Freigabe gilt genau für diesen Text einmal; danach darf das Konto live posten.",
    draftTitle: (change: string, title: string) => `${change === "update" ? "Social-Entwurf ändern" : "Neuer Social-Entwurf"}: ${title}`,
    images: (n: number) => `${n} ${n === 1 ? "Bild" : "Bilder"}`,
    draftNote: "Die Freigabe speichert genau diesen Entwurf. Veröffentlicht wird nichts; dafür braucht es eine eigene Freigabe.",
    cancelTitle: (title: string) => `Geplanten Social-Beitrag zurück zum Entwurf: ${title}`,
    cancelNote: "Seine Freigabe endet. Ein Beitrag, der gerade gesendet wird, behält, was schon draußen ist.",
    untitled: "Ohne Titel",
  },
};

const renderer: ActionRequestRenderer = {
  accepts: (item) => item.summary?.operation?.kind === "social_post",
  component: ({ item, de, pending, decide }) => {
    const { project } = useWorkspace();
    const op = item.summary.operation as Operation;
    const t = TEXT[de ? "de" : "en"];
    const platforms = socialText(de ? "de" : "en").platform;
    return (
      <article className="action-request">
        <h3>{op.mode === "at" ? t.at : t.now}</h3>
        <p>{op.mode === "at" && op.local ? `${op.local.replace("T", " ")} (${op.timeZone})` : t.immediately}</p>
        {op.variants.map((v) => (
          <section key={v.accountId}>
            <h4>
              {v.handle} <span className="field-hint">{platforms[v.platform]}</span>
            </h4>
            <blockquote style={{ whiteSpace: "pre-wrap" }}>{v.body}</blockquote>
            {v.media.map((m) => (
              <img
                key={m.mediaId}
                src={`/api${socialPath(project.id, `/media/${m.mediaId}/content?rendition=jpeg`)}`}
                alt={m.altText ?? ""}
                width={120}
                loading="lazy"
              />
            ))}
          </section>
        ))}
        <p className="panel-note">{t.note}</p>
        <div className="form-actions">
          <Button disabled={pending} onClick={() => decide("approve")}>
            {t.approve}
          </Button>
          <Button variant="outline" disabled={pending} onClick={() => decide("reject")}>
            {t.reject}
          </Button>
        </div>
      </article>
    );
  },
};

/** The owner's approval of one real test post on an account (S5). */
const verifyRenderer: ActionRequestRenderer = {
  accepts: (item) => item.summary?.operation?.kind === "social_verify_write",
  component: ({ item, de, pending, decide }) => {
    const { project } = useWorkspace();
    const op = item.summary.operation as { platform: SocialPlatform; handle: string; text: string; mediaId?: string | null };
    const t = TEXT[de ? "de" : "en"];
    const platforms = socialText(de ? "de" : "en").platform;
    return (
      <article className="action-request">
        <h3>{t.verifyTitle(op.handle)}</h3>
        <p className="field-hint">{platforms[op.platform]}</p>
        <blockquote style={{ whiteSpace: "pre-wrap" }}>{op.text}</blockquote>
        {op.mediaId && (
          <img src={`/api${socialPath(project.id, `/media/${op.mediaId}/content?rendition=jpeg`)}`} alt="" width={120} loading="lazy" />
        )}
        <p className="panel-note">{t.verifyNote}</p>
        <div className="form-actions">
          <Button disabled={pending} onClick={() => decide("approve")}>
            {t.approve}
          </Button>
          <Button variant="outline" disabled={pending} onClick={() => decide("reject")}>
            {t.reject}
          </Button>
        </div>
      </article>
    );
  },
};

function Decide({ t, pending, decide }: { t: (typeof TEXT)["en"]; pending: boolean; decide: (d: "approve" | "reject") => void }) {
  return (
    <div className="form-actions">
      <Button disabled={pending} onClick={() => decide("approve")}>
        {t.approve}
      </Button>
      <Button variant="outline" disabled={pending} onClick={() => decide("reject")}>
        {t.reject}
      </Button>
    </div>
  );
}

/** A draft an outside client or the assistant proposed (S7): the texts per account. */
const draftRenderer: ActionRequestRenderer = {
  accepts: (item) => item.summary?.operation?.kind === "social_draft",
  component: ({ item, de, pending, decide }) => {
    const op = item.summary.operation as {
      change: "create" | "update";
      title: string | null;
      variants: Array<{ accountId: string; platform: SocialPlatform; handle: string; body: string; images: number }>;
    };
    const t = TEXT[de ? "de" : "en"];
    const platforms = socialText(de ? "de" : "en").platform;
    return (
      <article className="action-request">
        <h3>{t.draftTitle(op.change, op.title ?? t.untitled)}</h3>
        {op.variants.map((v) => (
          <section key={v.accountId}>
            <h4>
              {v.handle} <span className="field-hint">{platforms[v.platform]}</span>
            </h4>
            <blockquote style={{ whiteSpace: "pre-wrap" }}>{v.body}</blockquote>
            {v.images > 0 && <p className="field-hint">{t.images(v.images)}</p>}
          </section>
        ))}
        <p className="panel-note">{t.draftNote}</p>
        <Decide t={t} pending={pending} decide={decide} />
      </article>
    );
  },
};

/** A proposed return of a planned post to a draft (S7). */
const cancelRenderer: ActionRequestRenderer = {
  accepts: (item) => item.summary?.operation?.kind === "social_cancel",
  component: ({ item, de, pending, decide }) => {
    const op = item.summary.operation as { title: string | null; local: string | null; timeZone: string };
    const t = TEXT[de ? "de" : "en"];
    return (
      <article className="action-request">
        <h3>{t.cancelTitle(op.title ?? t.untitled)}</h3>
        {op.local && <p>{`${op.local.replace("T", " ")} (${op.timeZone})`}</p>}
        <p className="panel-note">{t.cancelNote}</p>
        <Decide t={t} pending={pending} decide={decide} />
      </article>
    );
  },
};

/** Renderers of the social action types (manifest `actionRequests`). */
export const socialActionRequests: Record<string, ActionRequestRenderer> = {
  "social.post.schedule": renderer,
  "social.post.publish_now": renderer,
  "social.account.verify_write": verifyRenderer,
  // Proposals of outside clients and the assistant (S7).
  "social.mcp.social_schedule": renderer,
  "social.mcp.social_publish_now": renderer,
  "social.mcp.social_draft_create": draftRenderer,
  "social.mcp.social_draft_update": draftRenderer,
  "social.mcp.social_cancel": cancelRenderer,
};
