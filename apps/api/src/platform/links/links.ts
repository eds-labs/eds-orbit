import { randomUUID } from "node:crypto";
import { z } from "zod";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  LINK_RELATIONS,
  OBJECT_TYPE,
  type Actor,
  type LinkRelation,
  type ObjectRef,
} from "../../../../../packages/module-contracts/src/index.ts";
import { audit, DomainError } from "../shared.ts";
import {
  ownerEnabled,
  registeredLinkType,
} from "../modules/contributions.ts";
import { enabledModules } from "../modules/enforcement.ts";
import {
  effectiveRole,
  moduleScope,
  visibleModules,
} from "../tenancy/module-roles.ts";
import { can } from "../tenancy/permissions.ts";
import { publishEvent } from "../events/events.ts";
import type { PeriodicTask } from "../jobs/types.ts";
import type { LinkTypeDef, ResolvedObject } from "./types.ts";

// Object links (ADR 0016): same-project references between objects of any
// module. Each side's module resolves its object and decides who may link
// to it; a reader without that right sees a restricted placeholder.

export const objectRef = z
  .object({ type: z.string().regex(OBJECT_TYPE), id: z.uuid() })
  .strict();
export const linkInput = z
  .object({
    source: objectRef,
    target: objectRef,
    relation: z.enum(LINK_RELATIONS),
  })
  .strict();

type LinkRow = {
  id: string;
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  relation: string;
  createdByKind: string;
  createdAt: Date;
};

export type LinkedObject = {
  type: string;
  id: string;
  label: { en: string; de: string } | null;
  /** ok: resolved; restricted: the reader may not see it; missing: gone or its module is off. */
  state: "ok" | "restricted" | "missing";
  title?: string;
  status?: string;
  statusCategory?: string;
  href?: string;
  sensitive?: boolean;
};
export type LinkView = {
  id: string;
  relation: LinkRelation;
  /** outgoing: the object asked about is the link's source. */
  direction: "outgoing" | "incoming";
  object: LinkedObject;
  createdByKind: string;
  createdAt: string;
};

type Access =
  | { state: "ok"; def: LinkTypeDef & { owner: string }; scope: Scope }
  | { state: "unknown" | "unavailable" | "forbidden"; def?: LinkTypeDef & { owner: string } };

/** Whether this member may link to (and see) objects of a type. */
async function access(
  tx: DbTx,
  scope: Scope,
  type: string,
  enabled: () => Promise<ReadonlySet<string> | undefined>,
): Promise<Access> {
  const def = registeredLinkType(type);
  if (!def) return { state: "unknown" };
  if (!ownerEnabled(def.owner, visibleModules(scope, await enabled())))
    return { state: "unavailable", def };
  const role = effectiveRole(scope, def.owner);
  if (role === "none") return { state: "unavailable", def };
  if (!can({ role }, def.linkPermission)) return { state: "forbidden", def };
  return { state: "ok", def, scope: moduleScope(scope, def.owner) };
}

function memo<T>(load: () => Promise<T>) {
  let value: Promise<T> | undefined;
  return () => (value ??= load());
}

const sameRef = (row: LinkRow, ref: ObjectRef, side: "source" | "target") =>
  row[`${side}Type`] === ref.type && row[`${side}Id`] === ref.id;

/** Ensures one side of a new link is reachable, permitted and exists. */
async function requireObject(
  tx: DbTx,
  scope: Scope,
  ref: ObjectRef,
  enabled: () => Promise<ReadonlySet<string> | undefined>,
) {
  const a = await access(tx, scope, ref.type, enabled);
  if (a.state === "unknown") throw new DomainError("LINK_TYPE_UNKNOWN", 422);
  if (a.state === "forbidden") throw new DomainError("FORBIDDEN", 403);
  if (a.state !== "ok") throw new DomainError("LINK_OBJECT_NOT_FOUND", 404);
  const found = await a.def.resolve(tx, a.scope, [ref.id]);
  if (!found.has(ref.id)) throw new DomainError("LINK_OBJECT_NOT_FOUND", 404);
}

/**
 * Links two objects. Both sides must be of registered types whose modules
 * the member can use, with each type's link permission, and must exist.
 */
export async function createLink(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
  actor: Actor,
) {
  const input = linkInput.parse(raw);
  if (
    input.source.type === input.target.type &&
    input.source.id === input.target.id
  )
    throw new DomainError("LINK_SELF", 422);
  const enabled = memo(() => enabledModules(tx, scope));
  await requireObject(tx, scope, input.source, enabled);
  await requireObject(tx, scope, input.target, enabled);
  // The project lock serializes writers, so this check cannot race.
  const existing = await tx.objectLink.findFirst({
    where: {
      projectId: scope.projectId,
      sourceType: input.source.type,
      sourceId: input.source.id,
      relation: input.relation,
      targetType: input.target.type,
      targetId: input.target.id,
      removedAt: null,
    },
  });
  if (existing) throw new DomainError("LINK_EXISTS", 409);
  const row = await tx.objectLink.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      sourceType: input.source.type,
      sourceId: input.source.id,
      targetType: input.target.type,
      targetId: input.target.id,
      relation: input.relation,
      createdByKind: actor.kind,
      createdById: actor.id,
    },
  });
  await audit(tx, scope, "platform.link.created", row.id, {
    sourceType: row.sourceType,
    targetType: row.targetType,
    relation: row.relation,
  });
  await linkEvent(tx, scope, "platform.link.created", row, actor);
  return row;
}

async function linkEvent(
  tx: DbTx,
  scope: Scope,
  type: "platform.link.created" | "platform.link.removed",
  row: LinkRow,
  actor: Actor,
) {
  await publishEvent(tx, scope, {
    type,
    subject: { type: "platform.link", id: row.id },
    actor,
    origin: "platform",
    data: {
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      targetType: row.targetType,
      targetId: row.targetId,
      relation: row.relation,
    },
  });
}

/**
 * Removes a link softly. The member needs the link permission of every side
 * whose module is still reachable, and at least one such side.
 */
export async function removeLink(
  tx: DbTx,
  scope: Scope,
  linkId: string,
  actor: Actor,
) {
  const row = await tx.objectLink.findFirst({
    where: { projectId: scope.projectId, id: z.uuid().parse(linkId), removedAt: null },
  });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  const enabled = memo(() => enabledModules(tx, scope));
  const sides = [
    await access(tx, scope, row.sourceType, enabled),
    await access(tx, scope, row.targetType, enabled),
  ];
  if (sides.some((s) => s.state === "forbidden"))
    throw new DomainError("FORBIDDEN", 403);
  if (!sides.some((s) => s.state === "ok"))
    throw new DomainError("NOT_FOUND", 404);
  await tx.objectLink.update({
    where: { id: row.id },
    data: { removedAt: new Date(), removedById: actor.id },
  });
  await audit(tx, scope, "platform.link.removed", row.id, {
    sourceType: row.sourceType,
    targetType: row.targetType,
    relation: row.relation,
  });
  await linkEvent(tx, scope, "platform.link.removed", row, actor);
}

/**
 * Removes every link of an object its module is deleting, in the deleting
 * transaction. The module has already checked the member's rights.
 */
export async function removeLinksFor(
  tx: DbTx,
  scope: Scope,
  ref: ObjectRef,
  actor: Actor,
) {
  const rows = await activeLinks(tx, scope, ref);
  if (!rows.length) return 0;
  await tx.objectLink.updateMany({
    where: { projectId: scope.projectId, id: { in: rows.map((r) => r.id) } },
    data: { removedAt: new Date(), removedById: actor.id },
  });
  for (const row of rows)
    await linkEvent(tx, scope, "platform.link.removed", row, actor);
  return rows.length;
}

/** The active links of an object, in either direction, oldest first. */
export function activeLinks(tx: DbTx, scope: Scope, ref: ObjectRef) {
  return tx.objectLink.findMany({
    where: {
      projectId: scope.projectId,
      removedAt: null,
      OR: [
        { sourceType: ref.type, sourceId: ref.id },
        { targetType: ref.type, targetId: ref.id },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 500,
  });
}

/**
 * The object's links as the member may see them: every other side resolved
 * by its module, restricted without the type's link permission, missing
 * when it is gone or its module is off.
 */
export async function linksOf(
  tx: DbTx,
  scope: Scope,
  ref: ObjectRef,
): Promise<LinkView[]> {
  const rows = await activeLinks(tx, scope, ref);
  const enabled = memo(() => enabledModules(tx, scope));
  const others = rows.map((row) =>
    sameRef(row, ref, "source")
      ? { row, direction: "outgoing" as const, type: row.targetType, id: row.targetId }
      : { row, direction: "incoming" as const, type: row.sourceType, id: row.sourceId },
  );
  const byType = new Map<string, string[]>();
  for (const o of others)
    byType.set(o.type, [...(byType.get(o.type) ?? []), o.id]);
  const resolved = new Map<string, { access: Access; found: ReadonlyMap<string, ResolvedObject> }>();
  for (const [type, ids] of byType) {
    const a = await access(tx, scope, type, enabled);
    const found =
      a.state === "ok"
        ? await a.def.resolve(tx, a.scope, [...new Set(ids)])
        : new Map<string, ResolvedObject>();
    resolved.set(type, { access: a, found });
  }
  return others.map(({ row, direction, type, id }) => {
    const { access: a, found } = resolved.get(type)!;
    const base = { type, id, label: a.def?.label ?? null };
    const hit = found.get(id);
    const object: LinkedObject =
      a.state === "forbidden"
        ? { ...base, state: "restricted" }
        : a.state === "ok" && hit
          ? {
              ...base,
              state: "ok",
              title: hit.title,
              status: hit.status,
              statusCategory: hit.statusCategory,
              href: hit.href,
              sensitive: hit.sensitive,
            }
          : { ...base, state: "missing" };
    return {
      id: row.id,
      relation: row.relation as LinkRelation,
      direction,
      object,
      createdByKind: row.createdByKind,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

/** Link picker candidates of one type the member may link to. */
export async function linkTargets(
  tx: DbTx,
  scope: Scope,
  type: string,
  query: string,
  limit = 20,
) {
  const a = await access(tx, scope, type, memo(() => enabledModules(tx, scope)));
  if (a.state === "unknown") throw new DomainError("LINK_TYPE_UNKNOWN", 422);
  if (a.state !== "ok" || !a.def.search) return [];
  return a.def.search(tx, a.scope, query.trim().slice(0, 200), Math.min(limit, 50));
}

const lastPrune = new Map<string, number>();
/**
 * Once a week per project: removes links whose object its module reports
 * gone. Types of unavailable or disabled modules are left alone, so turning
 * a module off never loses its links.
 */
export const linkPrune: PeriodicTask = {
  name: "object-link-prune",
  async run(scope) {
    const now = Date.now();
    if (now - (lastPrune.get(scope.projectId) ?? 0) < 7 * 24 * 3600000) return;
    lastPrune.set(scope.projectId, now);
    await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const rows = await tx.objectLink.findMany({
        where: { projectId: scope.projectId, removedAt: null },
        take: 5000,
      });
      const enabled = memo(() => enabledModules(tx, scope));
      const ids = new Map<string, Set<string>>();
      for (const row of rows) {
        ids.set(row.sourceType, (ids.get(row.sourceType) ?? new Set()).add(row.sourceId));
        ids.set(row.targetType, (ids.get(row.targetType) ?? new Set()).add(row.targetId));
      }
      const gone = new Set<string>();
      for (const [type, set] of ids) {
        const a = await access(tx, scope, type, enabled);
        if (a.state !== "ok") continue;
        let found: ReadonlyMap<string, ResolvedObject>;
        try {
          found = await a.def.resolve(tx, a.scope, [...set]);
        } catch {
          continue;
        }
        for (const id of set) if (!found.has(id)) gone.add(`${type}:${id}`);
      }
      const stale = rows.filter(
        (r) =>
          gone.has(`${r.sourceType}:${r.sourceId}`) ||
          gone.has(`${r.targetType}:${r.targetId}`),
      );
      if (!stale.length) return;
      await tx.objectLink.updateMany({
        where: { projectId: scope.projectId, id: { in: stale.map((r) => r.id) } },
        data: { removedAt: new Date(), removedById: "system:prune" },
      });
      await audit(tx, scope, "platform.link.pruned", scope.projectId, {
        count: stale.length,
      });
    });
  },
};
