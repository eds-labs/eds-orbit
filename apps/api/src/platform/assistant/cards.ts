import type { MarketingPlanView } from "../../../../../packages/schemas/src/index.ts";
import { z } from "zod";

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
  pendingReviewLimit?: number;
  // Days of earlier topics the strategy avoids (14 to 60); absent means 14.
  historyDays?: number;
  // How approved posts leave Orbit (R73): published, or only drafts in Postiz.
  delivery: "publish" | "postiz_draft";
  approvalMode?: "human_each" | "delegated_review";
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
  // A composed creative per post (Creative Studio); absent for none.
  creative?: {
    templates?: string[];
    artPer: "run" | "post";
    imageKind: string;
  };
  // Null once the draft has no open confirmation request.
  actionRequestId: string | null;
};

export type ChatCard = {
  kind:
    | "source"
    | "asset"
    | "link"
    | "status"
    | "assignment"
    | "marketing_plan"
    | "context_proposal"
    | "notice"
    // Internal (personal-mode.ts): stored with messages, never read back.
    | "page_context"
    | "turn_context";
  label: string;
  href?: string;
  status?: string;
  resourceId?: string;
  version?: number;
  assignment?: AssignmentCard;
  marketingPlan?: MarketingPlanView;
  /**
   * The business project a card belongs to (ADR 0022): personal-mode cards
   * always name it, so links and decisions go to that project.
   */
  projectId?: string;
  projectName?: string;
  /** A decidable ActionRequest behind a `status` card (plan WP3.5). */
  actionRequest?: {
    id: string;
    version: number;
    packageHash: string;
    decidable: boolean;
    inline: boolean;
  };
  /** An entry the assistant proposes in "propose and confirm" mode (D-17). */
  contextProposal?: {
    text: string;
    category: "preference" | "project_note" | "decision" | "workflow";
    projectId?: string;
  };
  /** `page_context`: the hints a personal-mode user message carried (WP3.4). */
  pageContext?: {
    projectId?: string;
    route?: string;
    entity?: { type: string; id: string };
  };
  focusProjectId?: string;
  /** `turn_context`: the projects whose data entered the turn (ADR 0022 §5). */
  contextProjects?: string[];
  /** The metadata of a `notice` message, stored as its first card. */
  notice?: {
    kind:
      | "work_order_finished"
      | "work_order_failed"
      | "context_saved"
      // Briefings (ADR 0023 item 8) and their optional AI summary.
      | "briefing"
      | "briefing_summary";
    key: string;
    entryId?: string;
    text?: string;
  };
};

const cardSchema = z
  .object({
    kind: z.enum(["source", "asset", "link", "status"]),
    label: z.string().max(160),
    href: z.string().max(600).optional(),
    status: z.string().max(80).optional(),
    resourceId: z.uuid().optional(),
    version: z.number().int().optional(),
  })
  .strict();

/**
 * Checks a read tool's result and cards before they reach a model: the
 * tool's own schema, at most 20 known cards and 12 000 bytes together.
 */
export function checkToolResult<T extends z.ZodType>(
  schema: T,
  result: unknown,
  cards: unknown,
) {
  const parsed = schema.parse(result);
  const checkedCards = z.array(cardSchema).max(20).parse(cards);
  if (
    Buffer.byteLength(JSON.stringify({ result: parsed, cards: checkedCards })) >
    12000
  )
    throw new Error("CHAT_TOOL_RESULT_LIMIT");
  return { result: parsed, cards: checkedCards };
}

/**
 * Whether a card's resource is still what the card showed: a source still
 * active, an asset still approved for use, at the card's version. Cards
 * that fail it are shown as stale (WP2.2; per project in personal mode).
 */
export function resourceCardValid(
  card: { kind: string; version?: number },
  resource: { version: number; data: unknown } | undefined,
) {
  const d = (resource?.data ?? {}) as Record<string, unknown>;
  return Boolean(
    resource &&
      resource.version === card.version &&
      (card.kind === "source"
        ? d.status === "active"
        : d.usageApproved === true && d.assetStatus === "approved"),
  );
}
