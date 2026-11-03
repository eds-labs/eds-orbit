import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import { organizationCalendarFor } from "../src/modules/social/calendar/calendar.ts";
import { createPost } from "../src/modules/social/posts/posts.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

/**
 * The organization calendar (ADR 0020 §6.2, S6): the posts of every project
 * of the organization where the member may read Social and the module is on;
 * nothing of any other project, not even its name.
 */
describe.skipIf(!enabled)("social organization calendar", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let foreign: Awaited<ReturnType<typeof createSocialProject>>;
  const extra: Record<string, string> = {};
  const range = { from: "2026-12-01T00:00:00Z", to: "2027-01-01T00:00:00Z" };
  const previousRoles = process.env.ORBIT_MODULE_ROLES;

  /** A project of the same organization, with the viewer as member or not and the module on or off. */
  const project = async (name: string, opts: { member: boolean; social: boolean; socialRole?: "none" }) => {
    const workspaceId = p.owner.workspaceId;
    const row = await authDb.project.create({ data: { workspaceId, name } });
    if (opts.member) {
      await authDb.projectMember.create({ data: { workspaceId, projectId: row.id, userId: p.viewer.userId, role: "viewer" } });
      if (opts.socialRole)
        await authDb.projectMemberModuleRole.create({
          data: { workspaceId, projectId: row.id, userId: p.viewer.userId, moduleId: "social", role: opts.socialRole },
        });
    }
    await scoped(workspaceId, row.id, async (tx) => {
      if (opts.social)
        await tx.projectModule.create({
          data: { workspaceId, projectId: row.id, moduleId: "social", enabled: true, moduleVersion: "0.1.0", changedBy: p.owner.userId },
        });
      const account = await tx.socialAccount.create({
        data: {
          id: randomUUID(),
          workspaceId,
          projectId: row.id,
          connectionId: randomUUID(),
          platform: "telegram",
          externalId: randomUUID(),
          handle: "@c",
          displayName: "C",
          createdBy: p.owner.userId,
        },
      });
      const scope = { workspaceId, projectId: row.id, userId: p.owner.userId, role: "owner" as const };
      const post = await createPost(tx, scope, { baseText: `In ${name}`, baseMedia: [], variants: [{ accountId: account.id }] });
      await tx.socialPost.update({ where: { id: post.id }, data: { scheduleMode: "at", scheduledAt: new Date("2026-12-10T09:00:00Z") } });
    });
    return row.id;
  };

  beforeAll(async () => {
    process.env.ORBIT_SOCIAL = "true";
    process.env.ORBIT_MODULE_ROLES = "true";
    p = await createSocialProject({ name: "Synthetic social home" });
    foreign = await createSocialProject({ name: "Synthetic social elsewhere" });
    await p.run(async (tx) => {
      const account = await tx.socialAccount.create({
        data: {
          id: randomUUID(),
          workspaceId: p.owner.workspaceId,
          projectId: p.owner.projectId,
          connectionId: randomUUID(),
          platform: "x",
          externalId: randomUUID(),
          handle: "@x",
          displayName: "X",
          createdBy: p.owner.userId,
        },
      });
      const post = await createPost(tx, p.owner, { baseText: "In home", baseMedia: [], variants: [{ accountId: account.id }] });
      await tx.socialPost.update({ where: { id: post.id }, data: { scheduleMode: "at", scheduledAt: new Date("2026-12-05T09:00:00Z") } });
    });
    extra.second = await project("Synthetic social second", { member: true, social: true });
    extra.notMember = await project("Synthetic social not mine", { member: false, social: true });
    extra.off = await project("Synthetic social off", { member: true, social: false });
    extra.hidden = await project("Synthetic social hidden", { member: true, social: true, socialRole: "none" });
  });
  afterEach(() => {
    process.env.ORBIT_SOCIAL = "true";
  });
  afterAll(async () => {
    if (previousRoles === undefined) delete process.env.ORBIT_MODULE_ROLES;
    else process.env.ORBIT_MODULE_ROLES = previousRoles;
    await p?.cleanup();
    await foreign?.cleanup();
    await closeDatabase();
  });

  it("shows the posts of the member's projects with Social, with their names", async () => {
    const result = await organizationCalendarFor(p.viewer.userId, p.owner.workspaceId, range);
    expect(result.projects.map((x) => x.name).sort()).toEqual(["Synthetic social home", "Synthetic social second"]);
    expect(result.items.map((i) => i.projectName)).toEqual(["Synthetic social home", "Synthetic social second"]);
    const seen = JSON.stringify(result);
    for (const id of [extra.notMember, extra.off, extra.hidden, foreign.owner.projectId]) expect(seen).not.toContain(id!);
    expect(seen).not.toMatch(/not mine|social off|social hidden|elsewhere/);
  });

  it("narrows to chosen projects and ignores ones the member cannot read", async () => {
    const result = await organizationCalendarFor(p.viewer.userId, p.owner.workspaceId, {
      ...range,
      projectIds: `${extra.second},${extra.notMember}`,
    });
    expect(result.items.map((i) => i.projectId)).toEqual([extra.second]);
  });

  it("says when it read only some of the member's projects", async () => {
    const result = await organizationCalendarFor(p.viewer.userId, p.owner.workspaceId, range, { projects: 1, candidates: 200 });
    expect(result.items).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.projects).toHaveLength(2);
  });

  it("counts only the member's projects against the candidate limit", async () => {
    // By name: hidden, home, not mine, off, second. "Not mine" is no candidate.
    const result = await organizationCalendarFor(p.viewer.userId, p.owner.workspaceId, range, { projects: 20, candidates: 4 });
    expect(result.projects.map((x) => x.name).sort()).toEqual(["Synthetic social home", "Synthetic social second"]);
  });

  it("answers 404 for another organization and while Social is off", async () => {
    await expect(organizationCalendarFor(p.viewer.userId, foreign.owner.workspaceId, range)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    process.env.ORBIT_SOCIAL = "false";
    await expect(organizationCalendarFor(p.viewer.userId, p.owner.workspaceId, range)).rejects.toMatchObject({ code: "SOCIAL_DISABLED", status: 404 });
  });
});
