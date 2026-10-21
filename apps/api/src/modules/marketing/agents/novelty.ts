import { validateEvidence } from "../../../platform/knowledge/services.ts";
import { htmlToText } from "./channel-posts.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  create,
  data,
  entity,
  hash,
  update,
  DomainError,
} from "../../../shared.ts";
import {
  draftSimilarity,
  DUPLICATE_DRAFT_SIMILARITY,
} from "../pipeline/draft-similarity.ts";
export const NOVELTY_KIND = "marketing_topic_reservations";
export const HISTORY_DAYS = 14;
const currentWindow = (since: Date) => ({
  OR: [
    { createdAt: { gte: since } },
    ...["draft", "needs_review", "blocked_dependency"].map((status) => ({
      data: { path: ["status"], equals: status },
    })),
  ],
});
const LIMIT = 300,
  PER_CHANNEL = 8;
export { marketingTopic as topicIdentity } from "../../../../../../packages/schemas/src/index.ts";
import { marketingTopic as topicIdentity } from "../../../../../../packages/schemas/src/index.ts";
export const canonicalTopic = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
export const topicKey = (
  channel: string,
  value: z.infer<typeof topicIdentity>,
) =>
  hash({
    channel,
    topic: canonicalTopic(value.topic),
    angle: canonicalTopic(value.angle),
  });

/** One bounded source-aware view. Local drafts, manual output, packages and
 * assignments share a corpus; absent remote evidence is never called empty. */
export async function marketingHistory(
  tx: DbTx,
  scope: Scope,
  channels: string[],
  now = new Date(),
  days = HISTORY_DAYS,
) {
  const since = new Date(
    now.valueOf() - Math.min(60, Math.max(1, days)) * 86400000,
  );
  const read = (kind: string) =>
    tx.entity.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind,
        ...(kind === "content"
          ? currentWindow(since)
          : kind === "channel_posts"
            ? { updatedAt: { gte: since } }
            : { createdAt: { gte: since } }),
      },
      orderBy: { createdAt: "desc" },
      take: LIMIT + 1,
    });
  const [contents, remote, held, markers] = await Promise.all([
    read("content"),
    read("channel_posts"),
    read(NOVELTY_KIND),
    tx.entity.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: "channel_post_sync",
      },
      orderBy: { updatedAt: "desc" },
      take: 1,
    }),
  ]);
  if (!channels.length)
    channels = [
      ...new Set(
        [...contents, ...held, ...remote]
          .map((r) => String(data(r).channel ?? ""))
          .filter(Boolean),
      ),
    ].slice(0, 4);
  const missionIds = contents
    .map((r) => data(r).missionId)
    .filter((id): id is string => typeof id === "string");
  const missions = new Map(
    (missionIds.length
      ? await tx.entity.findMany({
          where: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            kind: "missions",
            id: { in: missionIds },
          },
          take: LIMIT,
        })
      : []
    ).map((r) => [r.id, data(r)]),
  );
  // Source-backed history is offered to models only under its current
  // evidence/model-use mandate. Keep a placeholder when rights have changed.
  const evidenceIds = [
    ...new Set(
      contents
        .map((r) => data(r).evidenceId)
        .filter(
          (id): id is string =>
            typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id),
        ),
    ),
  ];
  const evidences = new Map(
    (evidenceIds.length
      ? await tx.entity.findMany({
          where: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            kind: "evidence",
            id: { in: evidenceIds },
          },
          take: LIMIT + 1,
        })
      : []
    ).map((r) => [r.id, data(r)]),
  );
  const usableEvidence = new Map<string, boolean>();
  for (const id of evidenceIds)
    usableEvidence.set(
      id,
      evidences.get(id)?.forModel === true &&
        (await validateEvidence(tx, scope, id, now)).valid,
    );
  const publications = contents.length
    ? await tx.entity.findMany({
        where: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: "publications",
        },
        orderBy: { updatedAt: "desc" },
        take: LIMIT + 1,
      })
    : [];
  const byContent = new Map<string, Record<string, any>>();
  for (const p of publications)
    if (!byContent.has(data(p).contentId))
      byContent.set(data(p).contentId, data(p));
  let truncated = [contents, remote, held, publications].some(
    (rows) => rows.length > LIMIT,
  );
  const items: Array<{
    id: string;
    channel: string;
    source: "orbit" | "external" | "reservation";
    recordKind: "content" | "channel_posts" | "reservation";
    status: string;
    title: string;
    text: string;
    claims: string[];
    at: string;
    createdAt: string;
    origin: "package" | "autopilot" | "chat" | "mission" | "manual";
    missionId: string | null;
    topic: z.infer<typeof topicIdentity> | null;
    publication: { status: string; scheduledAt: string | null } | null;
    withheld?: "evidence_or_model_use";
  }> = [];
  const append = (item: (typeof items)[number]) => {
    if (channels.includes(item.channel)) items.push(item);
  };
  // Local current work is offered before remote history so drafts cannot be
  // displaced by a busy external feed. Scan bounds are explicit below.
  for (const row of contents.slice(0, LIMIT)) {
    const d = data(row);
    if (
      ["archived", "rejected", "deleted"].includes(d.status) ||
      d.supersededBy
    )
      continue;
    const withheld =
      !!d.evidenceId && usableEvidence.get(d.evidenceId) !== true;
    const publication = byContent.get(row.id);
    const mission = missions.get(d.missionId);
    const origin = !mission
      ? "manual"
      : mission.packageId
        ? "package"
        : mission.autopilot === true
          ? "autopilot"
          : mission.chatProposalId
            ? "chat"
            : "mission";
    append({
      id: row.id,
      channel: String(d.channel ?? ""),
      source: "orbit",
      recordKind: "content",
      status: String(d.status ?? "draft"),
      ...(withheld ? { withheld: "evidence_or_model_use" as const } : {}),
      title: withheld
        ? "Prior content (text withheld)"
        : String(d.title ?? "").slice(0, 160),
      text: withheld ? "" : String(d.body ?? "").slice(0, 280),
      claims: (withheld ? [] : (d.claims ?? []))
        .slice(0, 8)
        .map((c: any) => String(c.text).slice(0, 280)),
      at: String(d.scheduledAt ?? row.createdAt.toISOString()),
      createdAt: row.createdAt.toISOString(),
      origin,
      missionId: d.missionId ?? null,
      topic: withheld ? null : (d.novelty ?? null),
      publication: publication
        ? {
            status: String(publication.status),
            scheduledAt: publication.scheduledAt ?? null,
          }
        : null,
    });
  }
  for (const row of held.slice(0, LIMIT)) {
    const d = data(row);
    if (d.state !== "held" || Date.parse(d.expiresAt) <= now.valueOf())
      continue;
    append({
      id: row.id,
      channel: d.channel,
      source: "reservation",
      recordKind: "reservation",
      status: "held",
      createdAt: row.createdAt.toISOString(),
      origin: "mission",
      title: String(d.topic).slice(0, 160),
      text: String(d.angle).slice(0, 280),
      claims: [],
      at: row.createdAt.toISOString(),
      missionId: d.missionId ?? null,
      topic: { topic: d.topic, angle: d.angle, pillar: d.pillar ?? "" },
      publication: null,
    });
  }
  for (const row of remote
    .slice(0, LIMIT)
    .sort(
      (a, b) =>
        Date.parse(data(b).publishedAt) - Date.parse(data(a).publishedAt),
    )) {
    const d = data(row);
    if (
      !["PUBLISHED", "QUEUE"].includes(d.state) ||
      !Number.isFinite(Date.parse(d.publishedAt)) ||
      Date.parse(d.publishedAt) < since.valueOf()
    )
      continue;
    if (
      items.some(
        (i) =>
          i.channel === d.channel &&
          canonicalTopic(i.text) ===
            canonicalTopic(String(d.text ?? "").slice(0, 280)),
      )
    )
      continue;
    append({
      id: row.id,
      channel: d.channel,
      source: d.source === "orbit" ? "orbit" : "external",
      recordKind: "channel_posts",
      status: d.state === "QUEUE" ? "scheduled" : "published",
      createdAt: row.createdAt.toISOString(),
      origin: "manual",
      title: d.source === "orbit" ? "Orbit post" : "External post",
      text: htmlToText(String(d.text ?? "")).slice(0, 280),
      claims: [],
      at: d.publishedAt,
      missionId: null,
      topic: null,
      publication: null,
    });
  }
  // Reserve room for each source before filling unused capacity. A busy local
  // backlog must not erase the cached external evidence or held briefs.
  const candidates = items.splice(0);
  const chosen = new Set<string>();
  for (const channel of channels) {
    const own = candidates.filter((i) => i.channel === channel);
    for (const [source, count] of [
      ["orbit", 4],
      ["reservation", 2],
      ["external", 2],
    ] as const)
      for (const item of own.filter((i) => i.source === source).slice(0, count))
        chosen.add(item.id);
    let count = own.filter((i) => chosen.has(i.id)).length;
    for (const item of own)
      if (!chosen.has(item.id) && count < PER_CHANNEL) {
        chosen.add(item.id);
        count++;
      }
    if (own.length > PER_CHANNEL) truncated = true;
  }
  items.push(...candidates.filter((i) => chosen.has(i.id)));
  const marker = data(markers[0]);
  const successAt = Date.parse(marker.succeededAt ?? marker.attemptedAt ?? "");
  const coverage =
    marker.status !== "ok"
      ? marker.status === "failed"
        ? "failed"
        : "unavailable"
      : !Number.isFinite(successAt)
        ? "unavailable"
        : now.valueOf() - successAt > 2 * 3600000
          ? "stale"
          : "fresh";
  while (Buffer.byteLength(JSON.stringify(items)) > 10000 && items.length) {
    items.pop();
    truncated = true;
  }
  return {
    days,
    since: since.toISOString(),
    asOf: now.toISOString(),
    truncated,
    scanLimit: LIMIT,
    perChannelLimit: PER_CHANNEL,
    remote: {
      coverage,
      lastAttemptAt: marker.attemptedAt ?? null,
      lastSuccessAt: marker.succeededAt ?? null,
      complete: false,
    },
    items,
  };
}

/** Exact identity only: shared product facts are not an angle conflict. The
 * existing project transaction serializes every reservation/claim check. */
export async function reserveTopic(
  tx: DbTx,
  scope: Scope,
  input: {
    channel: string;
    identity: z.infer<typeof topicIdentity>;
    ownerKey: string;
    missionId?: string;
    runId?: string;
    contentId?: string;
  },
  now = new Date(),
) {
  const identity = topicIdentity.parse(input.identity),
    key = topicKey(input.channel, identity);
  if (!canonicalTopic(identity.topic) || !canonicalTopic(identity.angle))
    throw new DomainError("TOPIC_IDENTITY_EMPTY", 400);
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: NOVELTY_KIND,
      data: { path: ["topicKey"], equals: key },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  for (const row of rows) {
    const d = data(row);
    if (input.contentId && d.contentId === input.contentId) continue;
    if (d.ownerKey === input.ownerKey && d.state !== "released") return row;
    if (d.state !== "released" && Date.parse(d.expiresAt) > now.valueOf())
      throw new DomainError("TOPIC_ANGLE_RESERVED", 409);
  }
  // Structured manual content participates even if it was written without a model.
  const existing = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "content",
      ...currentWindow(new Date(now.valueOf() - HISTORY_DAYS * 86400000)),
      AND: [
        { data: { path: ["channel"], equals: input.channel } },
        { data: { path: ["noveltyKey"], equals: key } },
      ],
    },
    take: 100,
  });
  if (
    existing.some(
      (r) =>
        !data(r).supersededBy &&
        !["archived", "rejected", "deleted"].includes(data(r).status) &&
        r.id !== input.contentId &&
        (!input.missionId || data(r).missionId !== input.missionId),
    )
  )
    throw new DomainError("TOPIC_ANGLE_RESERVED", 409);
  return create(tx, scope, NOVELTY_KIND, {
    ...identity,
    topicKey: key,
    channel: input.channel,
    ownerKey: input.ownerKey,
    missionId: input.missionId ?? null,
    runId: input.runId ?? null,
    state: "held",
    expiresAt: new Date(now.valueOf() + HISTORY_DAYS * 86400000).toISOString(),
  });
}
export async function assertDistinctDraft(
  tx: DbTx,
  scope: Scope,
  channel: string,
  body: string,
  identity?: z.infer<typeof topicIdentity>,
  excludeMission?: string,
  excludeContent?: string,
) {
  const normalized = canonicalTopic(body);
  if (!normalized) return;
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "content",
      ...currentWindow(new Date(Date.now() - HISTORY_DAYS * 86400000)),
      data: { path: ["channel"], equals: channel },
    },
    orderBy: { createdAt: "desc" },
    take: LIMIT + 1,
  });
  if (rows.length > LIMIT)
    throw new DomainError("NOVELTY_HISTORY_TRUNCATED", 409);
  for (const row of rows) {
    const d = data(row);
    if (
      row.id === excludeContent ||
      (d.missionId === excludeMission && excludeMission !== undefined) ||
      d.supersededBy ||
      ["archived", "rejected", "deleted"].includes(d.status)
    )
      continue;
    if (
      canonicalTopic(String(d.body ?? "")) === normalized ||
      (identity &&
        d.novelty &&
        topicKey(channel, identity) === topicKey(channel, d.novelty) &&
        draftSimilarity(body, String(d.body ?? "")) >=
          DUPLICATE_DRAFT_SIMILARITY)
    )
      throw new DomainError("DUPLICATE_CONTENT", 409);
  }
}
export async function commitTopic(
  tx: DbTx,
  scope: Scope,
  id: string,
  contentId: string,
) {
  const row = await entity(tx, scope, NOVELTY_KIND, id);
  await update(tx, scope, row, { ...data(row), state: "committed", contentId });
}

/** Only an explicit structured brief is a topic constraint; a legacy goal is
 * not evidence of one angle. All output still enters shared history/body checks. */
export const missionTopic = (m: Record<string, any>) => m.novelty;
export const missionTopicOwner = (m: Record<string, any>, id: string) =>
  m.noveltyOwnerKey ?? `mission:${id}`;

/** Native edits participate in the same locked check and never inherit approval. */
export async function prepareContentNovelty(
  tx: DbTx,
  scope: Scope,
  value: Record<string, any>,
  contentId?: string,
) {
  await assertDistinctDraft(
    tx,
    scope,
    value.channel,
    value.body,
    value.novelty,
    undefined,
    contentId,
  );
  if (!value.novelty) return null;
  const hold = await reserveTopic(tx, scope, {
    channel: value.channel,
    identity: value.novelty,
    ownerKey: `manual:${randomUUID()}`,
    contentId,
  });
  value.noveltyKey = topicKey(value.channel, value.novelty);
  return hold.id;
}
