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
  },
  de: {
    at: "Social-Beitrag einplanen",
    now: "Social-Beitrag sofort veröffentlichen",
    immediately: "Sofort nach der Freigabe",
    note: "Die Freigabe gilt genau für diesen Inhalt und diese Zeit.",
    approve: "Freigeben",
    reject: "Ablehnen",
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

/** Renderers of the social action types (manifest `actionRequests`). */
export const socialActionRequests: Record<string, ActionRequestRenderer> = {
  "social.post.schedule": renderer,
  "social.post.publish_now": renderer,
};
