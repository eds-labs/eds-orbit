import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import type { InboxView } from "../inboxes.ts";

// The channel adapter contract (06 §3.2): the support domain stays
// channel-agnostic, so e-mail (WP5.3), the widget (WP5.4) and later channels
// plug in here, and any provider stays replaceable.

export type SupportChannel = "email" | "widget";

/** One customer message as a channel delivers it, normalized. */
export type NormalizedInbound = {
  /** The provider's message id (e-mail Message-ID); null when there is none. */
  externalId: string | null;
  contact: {
    email?: string;
    name?: string;
    locale?: string;
    /** The host app's user id, verified by the widget's HMAC. */
    externalUserId?: string;
  };
  subject: string;
  bodyText: string;
  /** Sanitized by the adapter before it gets here. */
  bodyHtml?: string;
  threadRef?: { ticketId?: string; inReplyTo?: string[] };
  /** Files the adapter already stored as platform files of the project. */
  attachments: { fileId: string; name: string; mime: string; size: number }[];
};

/** An agent's reply on its way out, handed to the channel by a job. */
export type OutboundMessage = {
  ticketId: string;
  messageId: string;
  to: { email?: string; contactId: string };
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  inReplyTo?: string;
};

export type SupportChannelAdapter = {
  channel: SupportChannel;
  capabilities: {
    inbound: boolean;
    outbound: boolean;
    attachments: boolean;
    realtime: boolean;
    threading: "headers" | "session" | "external_id";
  };
  /** Verified at the platform ingress; normalized here. */
  normalizeInbound(
    payload: unknown,
    inbox: InboxView,
  ): Promise<NormalizedInbound[]>;
  /**
   * Called by the deterministic executor job, never by a model. An ambiguous
   * transmit is "unknown" and is never sent again.
   */
  send(
    tx: DbTx,
    scope: Scope,
    msg: OutboundMessage,
  ): Promise<{
    outcome: "sent" | "not_sent" | "rejected" | "unknown";
    externalId?: string;
  }>;
};
