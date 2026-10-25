import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import type {
  PermissionDef,
  ServerModule,
} from "../../../packages/module-contracts/src/index.ts";
import {
  registerModules,
  registerTestModules,
} from "../src/modules/registry.ts";
import type { ModuleContributions } from "../src/platform/modules/contributions.ts";
import { create, data } from "../src/shared.ts";
import {
  createLink,
  linkPrune,
  linksOf,
  linkTargets,
  removeLink,
  removeLinksFor,
} from "../src/platform/links/links.ts";
import {
  eventJob,
  eventView,
  publishEvent,
} from "../src/platform/events/events.ts";
import type { DomainEventView } from "../src/platform/events/types.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

// Three modules that exist only in this test (ADR 0016): alpha and beta link
// to each other, beta's link permission is owner-only, and gamma is opt-in,
// so its subscriber stops while gamma is off.
const ALPHA_READ: PermissionDef = {
  key: "alpha.read",
  description: "Read alpha items",
  defaultRoles: ["owner", "editor", "viewer"],
};
const BETA_SECRET: PermissionDef = {
  key: "beta.secret",
  description: "See beta items",
  defaultRoles: ["owner"],
};
const manifest = (
  id: string,
  permissions: PermissionDef[],
  defaultEnabled = true,
): ServerModule => ({
  id,
  version: "1.0.0",
  displayName: { en: id, de: id },
  dependsOn: [],
  defaultEnabled,
  entityKinds: [{ kind: `fixture_${id}`, description: `Fixture ${id} items` }],
  tables: [],
  permissions,
});
const itemType = (kind: string, permission: PermissionDef) => ({
  label: { en: kind, de: kind },
  linkPermission: permission,
  async resolve(tx: DbTx, scope: Scope, ids: readonly string[]) {
    const rows = await tx.entity.findMany({
      where: { projectId: scope.projectId, kind, id: { in: [...ids] } },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        { title: String(data(r).title), status: "open", href: `/p/${scope.projectId}/${kind}?id=${r.id}` },
      ]),
    );
  },
  async search(tx: DbTx, scope: Scope, query: string) {
    const rows = await tx.entity.findMany({
      where: { projectId: scope.projectId, kind },
    });
    return rows
      .filter((r) => String(data(r).title).includes(query))
      .map((r) => ({ id: r.id, title: String(data(r).title) }));
  },
});

const received: DomainEventView[] = [];
const alpha: ModuleContributions = {
  linkTypes: { item: itemType("fixture_alpha", ALPHA_READ) },
  events: { publishes: ["alpha.item.changed", "alpha.item.removed"] },
};
const beta: ModuleContributions = {
  linkTypes: { item: itemType("fixture_beta", BETA_SECRET) },
  events: {
    subscribes: [
      {
        name: "beta.watch",
        types: ["alpha.item.*"],
        async handler(_tx, _scope, event) {
          received.push(event);
        },
      },
    ],
  },
};
const gamma: ModuleContributions = {
  events: {
    subscribes: [
      {
        name: "gamma.watch",
        types: ["alpha.item.changed"],
        async handler(_tx, _scope, event) {
          received.push(event);
        },
      },
    ],
  },
};
registerTestModules([
  { module: manifest("alpha", [ALPHA_READ]), contributions: alpha },
  { module: manifest("beta", [BETA_SECRET]), contributions: beta },
  { module: manifest("gamma", [], false), contributions: gamma },
]);
registerModules();

describe.skipIf(!enabled)("object links and domain events (ADR 0016)", () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  let owner: Scope, editor: Scope, other: Scope;
  let a1: string, a2: string, b1: string, b2: string, foreign: string;
  const worker = (s: Scope): Scope => ({ ...s, userId: "worker", role: "owner" });
  const run = <T>(s: Scope, fn: (tx: DbTx) => Promise<T>) =>
    scoped(s.workspaceId, s.projectId, fn);
  const item = (s: Scope, kind: string, title: string) =>
    run(s, (tx) => create(tx, s, kind, { title })).then((r) => r.id);
  const ref = (module: string, id: string) => ({ type: `${module}.item`, id });
  const actor = (s: Scope) => ({ kind: "user" as const, id: s.userId });
  const failure = (p: Promise<unknown>) =>
    p.then(
      () => "resolved",
      (e: Error) => e.message,
    );

  beforeAll(async () => {
    const user = await authDb.user.create({
      data: { id: randomUUID(), name: "Synthetic links user", email: `${randomUUID()}@example.invalid` },
    });
    users.push(user.id);
    const workspace = await authDb.workspace.create({
      data: { name: "Synthetic links", members: { create: { userId: user.id, role: "owner" } } },
    });
    workspaces.push(workspace.id);
    const p1 = await authDb.project.create({ data: { workspaceId: workspace.id, name: "Links A" } });
    const p2 = await authDb.project.create({ data: { workspaceId: workspace.id, name: "Links B" } });
    owner = { workspaceId: workspace.id, projectId: p1.id, userId: user.id, role: "owner" };
    editor = { ...owner, role: "editor" };
    other = { ...owner, projectId: p2.id };
    a1 = await item(owner, "fixture_alpha", "Alpha one");
    a2 = await item(owner, "fixture_alpha", "Alpha two");
    b1 = await item(owner, "fixture_beta", "Beta one");
    b2 = await item(owner, "fixture_beta", "Beta two");
    foreign = await item(other, "fixture_alpha", "Alpha elsewhere");
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("links two objects and shows the link from both sides", async () => {
    const link = await run(owner, (tx) =>
      createLink(tx, owner, { source: ref("alpha", a1), target: ref("beta", b1), relation: "relates_to" }, actor(owner)),
    );
    const fromA = await run(owner, (tx) => linksOf(tx, owner, ref("alpha", a1)));
    expect(fromA).toEqual([
      expect.objectContaining({
        id: link.id,
        relation: "relates_to",
        direction: "outgoing",
        object: expect.objectContaining({ type: "beta.item", id: b1, state: "ok", title: "Beta one" }),
      }),
    ]);
    const fromB = await run(owner, (tx) => linksOf(tx, owner, ref("beta", b1)));
    expect(fromB[0]).toMatchObject({ direction: "incoming", object: { id: a1, title: "Alpha one" } });
    const audits = await run(owner, (tx) =>
      tx.auditEvent.findMany({ where: { projectId: owner.projectId, resourceId: link.id } }),
    );
    expect(audits.map((a) => a.action)).toEqual(["platform.link.created"]);
    expect(JSON.stringify(audits[0]!.metadata)).not.toContain("Alpha");
  });

  it("refuses duplicates, self links, unknown types and objects out of reach", async () => {
    const body = { source: ref("alpha", a1), target: ref("beta", b1), relation: "relates_to" };
    expect(await failure(run(owner, (tx) => createLink(tx, owner, body, actor(owner))))).toBe("LINK_EXISTS");
    expect(
      await failure(run(owner, (tx) => createLink(tx, owner, { ...body, target: ref("alpha", a1) }, actor(owner)))),
    ).toBe("LINK_SELF");
    expect(
      await failure(
        run(owner, (tx) => createLink(tx, owner, { ...body, target: { type: "nobody.item", id: b1 } }, actor(owner))),
      ),
    ).toBe("LINK_TYPE_UNKNOWN");
    expect(
      await failure(run(owner, (tx) => createLink(tx, owner, { ...body, target: ref("beta", randomUUID()) }, actor(owner)))),
    ).toBe("LINK_OBJECT_NOT_FOUND");
    // Another project's object is invisible, even with the right type.
    expect(
      await failure(run(owner, (tx) => createLink(tx, owner, { ...body, target: ref("alpha", foreign) }, actor(owner)))),
    ).toBe("LINK_OBJECT_NOT_FOUND");
    expect(
      await failure(run(owner, (tx) => createLink(tx, owner, { ...body, relation: "owns" }, actor(owner)))),
    ).not.toBe("resolved");
  });

  it("needs each type's link permission and restricts what a reader may not see", async () => {
    expect(
      await failure(
        run(editor, (tx) =>
          createLink(tx, editor, { source: ref("alpha", a2), target: ref("beta", b2), relation: "implements" }, actor(editor)),
        ),
      ),
    ).toBe("FORBIDDEN");
    const seen = await run(editor, (tx) => linksOf(tx, editor, ref("alpha", a1)));
    expect(seen[0]!.object).toEqual({ type: "beta.item", id: b1, label: { en: "fixture_beta", de: "fixture_beta" }, state: "restricted" });
    // A member without access to beta's module sees the object as missing.
    const hidden = { ...editor, moduleRoles: { beta: "none" as const } };
    const none = await run(hidden, (tx) => linksOf(tx, hidden, ref("alpha", a1)));
    expect(none[0]!.object.state).toBe("missing");
    expect(none[0]!.object.title).toBeUndefined();
    expect(await run(editor, (tx) => linkTargets(tx, editor, "beta.item", "Beta"))).toEqual([]);
    expect(await run(owner, (tx) => linkTargets(tx, owner, "beta.item", "two"))).toEqual([{ id: b2, title: "Beta two" }]);
  });

  it("removes links softly and publishes both changes", async () => {
    const link = await run(owner, (tx) =>
      createLink(tx, owner, { source: ref("alpha", a2), target: ref("beta", b2), relation: "documents" }, actor(owner)),
    );
    expect(await failure(run(editor, (tx) => removeLink(tx, editor, link.id, actor(editor))))).toBe("FORBIDDEN");
    await run(owner, (tx) => removeLink(tx, owner, link.id, actor(owner)));
    expect(await run(owner, (tx) => linksOf(tx, owner, ref("alpha", a2)))).toEqual([]);
    const row = await run(owner, (tx) => tx.objectLink.findFirstOrThrow({ where: { id: link.id } }));
    expect(row.removedAt).not.toBeNull();
    const events = await run(owner, (tx) =>
      tx.domainEvent.findMany({ where: { projectId: owner.projectId, subjectId: link.id }, orderBy: { createdAt: "asc" } }),
    );
    expect(events.map((e) => e.type)).toEqual(["platform.link.created", "platform.link.removed"]);
    expect(events[0]!.data).toMatchObject({ sourceType: "alpha.item", targetType: "beta.item", relation: "documents" });
    // A removed link may be created again.
    await run(owner, (tx) =>
      createLink(tx, owner, { source: ref("alpha", a2), target: ref("beta", b2), relation: "documents" }, actor(owner)),
    );
    expect(await run(owner, (tx) => removeLinksFor(tx, owner, ref("beta", b2), actor(owner)))).toBe(1);
    expect(await run(owner, (tx) => linksOf(tx, owner, ref("alpha", a2)))).toEqual([]);
  });

  it("prunes links whose object was deleted, weekly", async () => {
    const gone = await item(owner, "fixture_beta", "Beta gone");
    const link = await run(owner, (tx) =>
      createLink(tx, owner, { source: ref("alpha", a2), target: ref("beta", gone), relation: "relates_to" }, actor(owner)),
    );
    await run(owner, (tx) => tx.entity.delete({ where: { id: gone } }));
    await linkPrune.run(worker(owner));
    const row = await run(owner, (tx) => tx.objectLink.findFirstOrThrow({ where: { id: link.id } }));
    expect(row.removedAt).not.toBeNull();
    expect(row.removedById).toBe("system:prune");
    // The surviving link of a1 is untouched.
    expect(await run(owner, (tx) => linksOf(tx, owner, ref("alpha", a1)))).toHaveLength(1);
  });

  const jobsFor = (eventId: string) =>
    run(owner, async (tx) =>
      (await tx.entity.findMany({ where: { projectId: owner.projectId, kind: "jobs" } })).filter(
        (j) => data(j).resourceId === eventId,
      ),
    );
  const deliver = async (job: { id: string; data: unknown }) =>
    eventJob.handler({ scope: worker(owner), jobId: job.id, job: job.data as Record<string, unknown>, executionMode: "test" });

  it("queues one job per subscriber and delivers the event", async () => {
    received.length = 0;
    const id = await run(owner, (tx) =>
      publishEvent(tx, owner, {
        type: "alpha.item.changed",
        subject: ref("alpha", a1),
        actor: actor(owner),
        origin: "alpha",
        data: { fields: ["title"] },
      }),
    );
    const jobs = await jobsFor(id!);
    expect(jobs.map((j) => data(j).subscriber).sort()).toEqual(["beta.watch", "gamma.watch"]);
    expect(jobs.every((j) => data(j).topic === "domain_event")).toBe(true);
    const beta = jobs.find((j) => data(j).subscriber === "beta.watch")!;
    expect(await deliver(beta)).toBeUndefined();
    expect(received).toEqual([
      expect.objectContaining({
        id,
        type: "alpha.item.changed",
        subject: { type: "alpha.item", id: a1 },
        depth: 0,
        correlationId: id,
        data: { fields: ["title"] },
      }),
    ]);
    // gamma is opt-in and not enabled for the project: its job stops.
    const gammaJob = jobs.find((j) => data(j).subscriber === "gamma.watch")!;
    expect(await deliver(gammaJob)).toEqual({ status: "blocked", errorCode: "MODULE_DISABLED" });
    expect(received).toHaveLength(1);
  });

  it("never delivers an event to the subscriber that caused it", async () => {
    const id = await run(owner, (tx) =>
      publishEvent(tx, owner, { type: "alpha.item.removed", subject: ref("alpha", a1), actor: { kind: "system", id: null }, origin: "beta.watch" }),
    );
    expect(await jobsFor(id!)).toEqual([]);
  });

  it("chains causes and stops a loop at depth five", async () => {
    let cause: DomainEventView | null = null;
    const ids: (string | null)[] = [];
    for (let i = 0; i < 7; i++) {
      const id: string | null = await run(owner, (tx) =>
        publishEvent(tx, owner, {
          type: "alpha.item.changed",
          subject: ref("alpha", a1),
          actor: { kind: "system", id: null },
          origin: "alpha",
          cause,
        }),
      );
      ids.push(id);
      if (!id) break;
      cause = eventView(await run(owner, (tx) => tx.domainEvent.findFirstOrThrow({ where: { id } })));
    }
    expect(ids).toHaveLength(7);
    expect(ids.slice(0, 6).every(Boolean)).toBe(true);
    expect(ids[6]).toBeNull();
    const chain = await run(owner, (tx) =>
      tx.domainEvent.findMany({ where: { correlationId: ids[0]! }, orderBy: { depth: "asc" } }),
    );
    expect(chain.map((e) => e.depth)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(chain[1]!.causationId).toBe(ids[0]);
    const audit = await run(owner, (tx) =>
      tx.auditEvent.findFirst({ where: { projectId: owner.projectId, action: "platform.event.depth_exceeded" } }),
    );
    expect(audit?.metadata).toMatchObject({ type: "alpha.item.changed", correlationId: ids[0] });
  });

  it("refuses undeclared types and oversized data", async () => {
    expect(
      await failure(
        run(owner, (tx) =>
          publishEvent(tx, owner, { type: "alpha.item.renamed", subject: ref("alpha", a1), actor: actor(owner), origin: "alpha" }),
        ),
      ),
    ).toBe("EVENT_TYPE_UNDECLARED: alpha.item.renamed");
    expect(
      await failure(
        run(owner, (tx) =>
          publishEvent(tx, owner, {
            type: "alpha.item.changed",
            subject: ref("alpha", a1),
            actor: actor(owner),
            origin: "alpha",
            data: { ids: Array.from({ length: 200 }, () => randomUUID()) },
          }),
        ),
      ),
    ).toBe("EVENT_DATA_TOO_LARGE");
  });
});
