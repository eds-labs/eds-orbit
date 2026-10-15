// Cards the assistant returns with a reply (WP2.2). Moved unchanged from
// chat-tools.ts; a card type registry (plans 03 §6.4) replaces the closed
// union when a second module contributes cards.

/**
 * Payload of an `assignment` card: the draft as the owner must confirm it,
 * with the pending `assignment.confirm` request to decide. Carried by value
 * and never through `resourceId`, which marks asset cards stale on read.
 */
export type AssignmentCard = {
  id: string;
  version: number;
  name: string;
  status: string;
  kind: string;
  contentType: string;
  channels: string[];
  schedule: {
    rhythm: string;
    weekdays: number[];
    times: string[];
    date?: string;
    leadMinutes: number;
  };
  topicFrame: string;
  tone?: string;
  image: boolean;
  styleAssetIds: string[];
  vetoMinutes: number;
  monthlyBudgetMicros: number;
  // How approved posts leave Orbit (R73): published, or only drafts in Postiz.
  delivery: "publish" | "postiz_draft";
  // One text and one image per slot for all channels (R76).
  sharedAcrossChannels: boolean;
  // The shape of every post (R77); absent for none.
  format?: {
    minChars: number;
    maxChars: number;
    hashtags: { min: number; max: number };
    paragraphs: boolean;
    cta?: string;
  };
  // A 16:9 banner per slot in the brand style (R78); absent for a free image.
  banner?: { template: "brand_landscape"; style?: string };
  // Null once the draft has no open confirmation request.
  actionRequestId: string | null;
};

export type ChatCard = {
  kind: "source" | "asset" | "link" | "status" | "assignment";
  label: string;
  href?: string;
  status?: string;
  resourceId?: string;
  version?: number;
  assignment?: AssignmentCard;
};
