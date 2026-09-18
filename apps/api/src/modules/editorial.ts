import { z } from "zod";
import type { DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import {
  create,
  data,
  entity,
  list,
  update,
  audit,
  hash,
  DomainError,
} from "../shared.ts";
import { checkClaims } from "./policy.ts";

const language = z.enum(["en", "de"]);
function editor(scope: Scope) {
  if (!["owner", "editor"].includes(scope.role))
    throw new DomainError("EDITOR_REQUIRED", 403);
}
export const briefProposalInput = z
  .object({
    brief: z.string().trim().min(5).max(2000),
    language: language.default("en"),
  })
  .strict();
/** Conservative local formatting, not a model plan or authorization. */
export function proposeBrief(raw: z.input<typeof briefProposalInput>) {
  const input = briefProposalInput.parse(raw);
  return {
    method: "local_brief_template",
    proposal: {
      title:
        input.brief
          .split(/[\n.!?]/)[0]!
          .trim()
          .slice(0, 120) || input.brief.slice(0, 120),
      goal: input.brief,
      language: input.language,
    },
    unknowns: [
      "audience",
      "targetAction",
      "channels",
      "startAt",
      "endAt",
      "maxContents",
      "sourceIds",
    ],
    limitations: [
      "No target numbers, budget, audience, dates or permissions have been inferred.",
      "Complete and review the structured fields before creating a mission.",
    ],
  };
}
export const communityImportInput = z
  .object({
    label: z.string().trim().min(3).max(160),
    authorizationConfirmed: z.literal(true),
    sourceId: z.uuid().optional(),
    questions: z
      .array(
        z
          .object({
            externalId: z.string().trim().min(1).max(160),
            text: z.string().trim().min(5).max(2000),
            language,
            receivedAt: z.iso.datetime().optional(),
            sensitive: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const communityLinkInput = z
  .object({
    groupId: z.uuid(),
    version: z.number().int().positive(),
    missionId: z.uuid().optional(),
    contentId: z.uuid().optional(),
  })
  .strict()
  .refine((v) => Boolean(v.missionId) !== Boolean(v.contentId), {
    message: "Link one mission or draft at a time",
  });
const stopWords = new Set(
  "a an the is are do does can i we you your our to for of in on with how what where when why ist sind ich wir du sie das der die ein eine und zu mit von für wie was wo wann bitte please".split(
    " ",
  ),
);
function normalize(text: string) {
  return text
    .toLocaleLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
function tokens(text: string) {
  return new Set(
    normalize(text)
      .split(" ")
      .filter((word) => word.length > 1 && !stopWords.has(word)),
  );
}
function overlap(a: Set<string>, b: Set<string>) {
  const intersection = [...a].filter((v) => b.has(v)).length;
  return intersection / Math.max(1, new Set([...a, ...b]).size);
}
function reviewRequired(question: { text: string; sensitive: boolean }) {
  return (
    question.sensitive ||
    /\b(complaint|refund|scam|password|private key|invest|investment|presale|token|lawsuit|medical|beschwerde|erstattung|betrug|passwort|investition|krank|anwalt)\b/i.test(
      question.text,
    )
  );
}
/** Imported questions are private untrusted observations, never knowledge facts or executable instructions. */
export async function importCommunityQuestions(
  tx: DbTx,
  scope: Scope,
  raw: z.input<typeof communityImportInput>,
) {
  editor(scope);
  const input = communityImportInput.parse(raw);
  if (
    new Set(input.questions.map((q) => q.externalId)).size !==
    input.questions.length
  )
    throw new DomainError("DUPLICATE_IMPORT_IDENTIFIER");
  if (input.sourceId) {
    const source = await entity(tx, scope, "sources", input.sourceId);
    if (data(source).status !== "active")
      throw new DomainError("SOURCE_NOT_ACTIVE");
  }
  const existing = await list(tx, scope, "community_questions"),
    groups = await list(tx, scope, "community_groups");
  const imported: typeof existing = [];
  const touched = new Set<string>();
  let skipped = 0;
  for (const question of input.questions) {
    const importKey = hash({
      label: input.label,
      sourceId: input.sourceId ?? null,
      externalId: question.externalId,
    });
    const previous = existing.find((q) => data(q).importKey === importKey);
    const contentHash = hash({
      text: question.text,
      language: question.language,
      sensitive: question.sensitive,
    });
    if (previous) {
      if (data(previous).contentHash !== contentHash)
        throw new DomainError("COMMUNITY_IMPORT_VERSION_CONFLICT", 409);
      skipped++;
      continue;
    }
    const sensitive = reviewRequired(question);
    const row = await create(tx, scope, "community_questions", {
      ...question,
      label: input.label,
      sourceId: input.sourceId ?? null,
      importKey,
      contentHash,
      authorizationConfirmedBy: scope.userId,
      importedAt: new Date().toISOString(),
      origin: "authorized_manual_import",
      untrusted: true,
      publicUse: false,
      modelUse: false,
      status: sensitive ? "review_required" : "imported",
    });
    imported.push(row);
    existing.push(row);
    let group = groups.find(
      (g) =>
        data(g).language === question.language &&
        data(g).reviewRequired === sensitive &&
        overlap(tokens(data(g).representativeText), tokens(question.text)) >=
          0.65,
    );
    if (group) {
      const changed = await update(tx, scope, group, {
        ...data(group),
        questionIds: [...new Set([...(data(group).questionIds ?? []), row.id])],
        questionCount: Number(data(group).questionCount ?? 0) + 1,
        lastImportedAt: new Date().toISOString(),
      });
      groups[groups.findIndex((g) => g.id === group!.id)] = changed;
      group = changed;
    } else {
      group = await create(tx, scope, "community_groups", {
        title: question.text.slice(0, 140),
        representativeText: question.text,
        language: question.language,
        questionIds: [row.id],
        questionCount: 1,
        status: sensitive ? "review_required" : "grouped",
        reviewRequired: sensitive,
        groupingMethod: "lexical_token_overlap_v1",
        missionIds: [],
        contentIds: [],
        publicReplyAllowed: false,
      });
      groups.push(group);
    }
    touched.add(group.id);
  }
  await audit(tx, scope, "community.import", scope.projectId, {
    imported: imported.length,
    skipped,
    groupIds: [...touched],
  });
  return {
    imported: imported.length,
    skipped,
    groups: groups.filter((g) => touched.has(g.id)),
  };
}
export async function linkCommunityGroup(
  tx: DbTx,
  scope: Scope,
  raw: z.input<typeof communityLinkInput>,
) {
  editor(scope);
  const input = communityLinkInput.parse(raw);
  const group = await entity(tx, scope, "community_groups", input.groupId);
  if (group.version !== input.version)
    throw new DomainError("VERSION_CONFLICT", 409);
  if (input.missionId) await entity(tx, scope, "missions", input.missionId);
  if (input.contentId) await entity(tx, scope, "content", input.contentId);
  const linked = await update(tx, scope, group, {
    ...data(group),
    ...(input.missionId
      ? {
          missionIds: [
            ...new Set([...(data(group).missionIds ?? []), input.missionId]),
          ],
        }
      : {
          contentIds: [
            ...new Set([...(data(group).contentIds ?? []), input.contentId]),
          ],
        }),
    publicReplyAllowed: false,
  });
  await audit(tx, scope, "community.link", group.id, {
    missionId: input.missionId ?? null,
    contentId: input.contentId ?? null,
  });
  return linked;
}
export const contentAdaptationInput = z
  .object({
    parentContentId: z.uuid(),
    version: z.number().int().positive(),
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(40000),
    channel: z.string().trim().min(1).max(80),
  })
  .strict();
function claimKeys(claims: any[]) {
  return new Set(
    claims.map((c) =>
      c.factId
        ? `fact:${c.factId}`
        : c.chunkId
          ? `chunk:${c.chunkId}`
          : `text:${normalize(c.text)}`,
    ),
  );
}
export async function adaptContent(
  tx: DbTx,
  scope: Scope,
  raw: z.input<typeof contentAdaptationInput>,
) {
  editor(scope);
  const input = contentAdaptationInput.parse(raw);
  const parent = await entity(tx, scope, "content", input.parentContentId),
    p = data(parent);
  if (parent.version !== input.version)
    throw new DomainError("VERSION_CONFLICT", 409);
  if (p.status !== "reviewed")
    throw new DomainError("REVIEWED_PARENT_REQUIRED", 409);
  const validation = await checkClaims(tx, scope, parent.id);
  if (!validation.valid) throw new DomainError("PARENT_EVIDENCE_INVALID", 409);
  const claims = (p.claims as any[]).filter((claim) =>
    input.body.includes(claim.text),
  );
  if (!claims.some((c) => c.factId || c.chunkId))
    throw new DomainError("ADAPTATION_REQUIRES_RETAINED_CLAIM", 409);
  const previous = await list(tx, scope, "content");
  const sameBody = previous.find(
    (c) =>
      data(c).channel === input.channel &&
      normalize(data(c).body ?? "") === normalize(input.body),
  );
  if (sameBody) throw new DomainError("EXACT_CHANNEL_DUPLICATE", 409);
  const matches = previous
    .filter(
      (c) =>
        data(c).channel === input.channel &&
        overlap(claimKeys(data(c).claims ?? []), claimKeys(claims)) >= 0.8,
    )
    .map((c) => ({
      contentId: c.id,
      version: c.version,
      reason: "claim_overlap",
    }));
  if (matches.length) throw new DomainError("CLAIM_OVERLAP_DUPLICATE", 409);
  // New variants never inherit approval, schedule or a human body-review hash.
  const draft = await create(tx, scope, "content", {
    title: input.title,
    body: input.body,
    type: "social",
    language: p.language,
    channel: input.channel,
    evidenceId: p.evidenceId,
    claims,
    ...(p.missionId ? { missionId: p.missionId } : {}),
    ...(p.campaignType ? { campaignType: p.campaignType } : {}),
    ...(p.profileVersion ? { profileVersion: p.profileVersion } : {}),
    ...(p.targetUrl ? { targetUrl: p.targetUrl } : {}),
    status: "draft",
    risk: p.risk ?? "routine",
    synthetic: p.synthetic === true,
    origin: "derived_adaptation",
    parentContentId: parent.id,
    parentContentVersion: parent.version,
    parentBodyHash: hash(p.body),
    adaptedBy: scope.userId,
    duplicateCheck: {
      mode: "exact_and_claim_overlap_v1",
      classification: matches.length
        ? "overlap_review_required"
        : input.channel !== p.channel
          ? "deliberate_channel_adaptation"
          : "new_framing",
      matches,
    },
    reviewRequired: true,
  });
  await audit(tx, scope, "content.adapt", draft.id, {
    parentContentId: parent.id,
    parentVersion: parent.version,
    overlapCount: matches.length,
  });
  return draft;
}
