import type { Entity } from "@/lib/api";
import type { KnowledgeCopy } from "./workspace-text";

/** Topic order of the Knowledge and To review pages. */
export const TOPICS = [
  "description",
  "audience",
  "platforms",
  "features",
  "limitations",
] as const;
type Topic = (typeof TOPICS)[number];

/** The owner's unsaved changes on one card. */
export type StatementEdit = {
  statement?: string;
  marketing?: boolean;
  support?: boolean;
  publicUse?: boolean;
};
export type EffectiveRights = {
  marketing: boolean;
  support: boolean;
  publicUse: boolean;
};

const record = (p: Entity) => p.data as Record<string, any>;

/** Topics in order, empty ones hidden. An unknown topic joins `description`. */
export function groupByTopic<T extends Entity>(
  items: T[],
): Array<{ topic: Topic; items: T[] }> {
  const known = new Set<string>(TOPICS);
  return TOPICS.map((topic) => ({
    topic,
    items: items.filter((p) => {
      const own = record(p).topic;
      return known.has(own) ? own === topic : topic === "description";
    }),
  })).filter((g) => g.items.length > 0);
}

/** Edit first, then the draft's rights, then Marketing and Support on, public off. */
export function effectiveRights(
  p: Entity,
  drafts: Entity[],
  edit?: StatementEdit,
): EffectiveRights {
  const own = drafts.find((d) => d.id === record(p).draftId);
  const rights = (record(own ?? ({ data: {} } as Entity)).input?.rights ??
    {}) as Partial<EffectiveRights>;
  return {
    marketing: edit?.marketing ?? rights.marketing ?? true,
    support: edit?.support ?? rights.support ?? true,
    publicUse: edit?.publicUse ?? rights.publicUse ?? false,
  };
}

export function effectiveStatement(p: Entity, edit?: StatementEdit): string {
  return edit?.statement ?? String(record(p).statement ?? "");
}

/** The longest statement `knowledge-proposal-decide` accepts. */
export const MAX_STATEMENT_LENGTH = 1000;

/** The proposal's source draft was replaced: the proposal can only be rejected. */
export function draftReplaced(p: Entity, drafts: Entity[]): boolean {
  const own = drafts.find((d) => d.id === record(p).draftId);
  return own ? record(own).status === "replaced" : false;
}

/** Pending, with text, within the length limit and at least one audience. */
export function selectable(
  p: Entity,
  drafts: Entity[],
  edit?: StatementEdit,
): boolean {
  const r = effectiveRights(p, drafts, edit);
  return (
    record(p).status === "pending" &&
    !draftReplaced(p, drafts) &&
    effectiveStatement(p, edit).trim().length > 0 &&
    effectiveStatement(p, edit).trim().length <= MAX_STATEMENT_LENGTH &&
    (r.marketing || r.support)
  );
}

/** What `knowledge-proposal-decide` takes, from the proposal's current version. */
export function decisionPayload(
  p: Entity,
  drafts: Entity[],
  edit?: StatementEdit,
): {
  proposalId: string;
  version: number;
  decision: "accept";
  statement: string;
  publicUse: boolean;
  audiences: Array<"marketing" | "support">;
} {
  const r = effectiveRights(p, drafts, edit);
  return {
    proposalId: p.id,
    version: p.version,
    decision: "accept",
    statement: effectiveStatement(p, edit).trim(),
    publicUse: r.publicUse,
    audiences: [
      ...(r.marketing ? (["marketing"] as const) : []),
      ...(r.support ? (["support"] as const) : []),
    ],
  };
}

/** The sentence of the bulk bar and whether the public-use note applies. */
export function bulkSummary(
  selected: Entity[],
  drafts: Entity[],
  edits: Record<string, StatementEdit>,
  t: KnowledgeCopy,
): { text: string; needsPublicNote: boolean } {
  const rights = selected.map((p) => effectiveRights(p, drafts, edits[p.id]));
  const marketing = rights.filter((r) => r.marketing).length;
  const support = rights.filter((r) => r.support).length;
  const publicCount = rights.filter((r) => r.publicUse).length;
  const total = selected.length;
  const uniform = rights.every(
    (r) =>
      r.marketing === rights[0]!.marketing && r.support === rights[0]!.support,
  );
  const audiences = !uniform
    ? `${t.marketing} ${marketing} · ${t.support} ${support}`
    : rights[0]!.marketing && rights[0]!.support
      ? t.bulkBoth
      : rights[0]!.marketing
        ? t.marketing
        : t.support;
  const count = (total === 1 ? t.bulkCountOne : t.bulkCountMany).replace(
    "{n}",
    String(total),
  );
  return {
    text: [
      count,
      audiences,
      t.bulkPublic.replace("{n}", String(publicCount)),
    ].join(" · "),
    needsPublicNote: publicCount < total,
  };
}

export type BulkResult = {
  done: string[];
  failed: Array<{ id: string; code: string }>;
};

/** Sends strictly one after another; a failure never stops the rest and never rejects. */
export async function confirmAll<T extends { id: string }>(
  items: T[],
  send: (item: T) => Promise<void>,
  codeOf: (error: unknown) => string,
): Promise<BulkResult> {
  const result: BulkResult = { done: [], failed: [] };
  for (const item of items) {
    try {
      await send(item);
      result.done.push(item.id);
    } catch (error) {
      result.failed.push({ id: item.id, code: codeOf(error) });
    }
  }
  return result;
}
