import { z } from "zod";
import type { RoutesContribution } from "../../../platform/http/routes.ts";
import { inSocial, SOCIAL_BASE } from "../http-scope.ts";
import { calendarItems, organizationCalendarFor } from "../calendar/calendar.ts";
import { userFor } from "../../../platform/tenancy/auth.ts";
import { DomainError } from "../../../shared.ts";
import { resolvePublication } from "../dispatch/control.ts";
import { SOCIAL_ANALYTICS_READ, SOCIAL_APPROVE, SOCIAL_COMPOSE, SOCIAL_PUBLISH, SOCIAL_READ } from "../permissions.ts";
import { postMetrics, recentPostMetrics } from "../analytics/collect.ts";
import { publishNow, reschedulePost, schedulePost } from "./approval.ts";
import { archivePost, cancelPost, createPost, getPost, listPosts, lockPost, refreshIssues, updatePost } from "./posts.ts";

// Post routes (ADR 0020 §6.2, S4). Reading needs social.read, writing
// social.compose, asking for a schedule or an immediate publication
// social.publish; who decides is the action type's (owner).

const postParam = z.object({ postId: z.string().max(64) }).passthrough();
const versionBody = z.object({ version: z.int().min(1) }).strict();

export const socialPostRoutes: RoutesContribution = ({ app, auth }) => {
  const post = (req: { params: unknown }) => postParam.parse(req.params).postId;
  app.get(`${SOCIAL_BASE}/posts`, (req) => inSocial(auth, req, SOCIAL_READ, (tx, scope) => listPosts(tx, scope, req.query)));
  // The timed posts of a range of at most 62 days (S6).
  app.get(`${SOCIAL_BASE}/calendar`, (req) => inSocial(auth, req, SOCIAL_READ, (tx, scope) => calendarItems(tx, scope, req.query)));
  // Across the member's projects of one organization, read-only (S6).
  app.get("/api/organizations/:workspaceId/social/calendar", async (req) => {
    const parsed = z.object({ workspaceId: z.uuid() }).passthrough().safeParse(req.params);
    if (!parsed.success) throw new DomainError("NOT_FOUND", 404);
    const user = await userFor(auth, req);
    return organizationCalendarFor(user.id, parsed.data.workspaceId, req.query);
  });
  app.post(`${SOCIAL_BASE}/posts`, async (req, reply) => {
    const created = await inSocial(auth, req, SOCIAL_COMPOSE, (tx, scope) => createPost(tx, scope, req.body));
    return reply.code(201).send(created);
  });
  app.get(`${SOCIAL_BASE}/posts/:postId`, (req) =>
    inSocial(auth, req, SOCIAL_READ, (tx, scope) => getPost(tx, scope, post(req))),
  );
  // The latest figures of a post's publications, and of the last days (S8).
  app.get(`${SOCIAL_BASE}/posts/:postId/metrics`, (req) =>
    inSocial(auth, req, SOCIAL_ANALYTICS_READ, async (tx, scope) => {
      await getPost(tx, scope, post(req));
      const [found] = await postMetrics(tx, scope, [post(req)]);
      return found ?? { postId: post(req), publications: [] };
    }),
  );
  app.get(`${SOCIAL_BASE}/analytics`, (req) =>
    inSocial(auth, req, SOCIAL_ANALYTICS_READ, (tx, scope) =>
      recentPostMetrics(tx, scope, z.object({ days: z.coerce.number().int().min(1).max(30).default(30) }).parse(req.query).days),
    ),
  );
  app.patch(`${SOCIAL_BASE}/posts/:postId`, (req) =>
    inSocial(auth, req, SOCIAL_COMPOSE, (tx, scope) => updatePost(tx, scope, post(req), req.body)),
  );
  app.post(`${SOCIAL_BASE}/posts/:postId/validate`, (req) =>
    inSocial(auth, req, SOCIAL_COMPOSE, async (tx, scope) => {
      await lockPost(tx, scope, post(req));
      return { variants: await refreshIssues(tx, scope, post(req)) };
    }),
  );
  app.post(`${SOCIAL_BASE}/posts/:postId/schedule`, (req) =>
    inSocial(auth, req, SOCIAL_PUBLISH, (tx, scope) => schedulePost(tx, scope, post(req), req.body)),
  );
  app.post(`${SOCIAL_BASE}/posts/:postId/publish-now`, (req) =>
    inSocial(auth, req, SOCIAL_PUBLISH, (tx, scope) => publishNow(tx, scope, post(req), req.body)),
  );
  app.post(`${SOCIAL_BASE}/posts/:postId/reschedule`, (req) =>
    inSocial(auth, req, SOCIAL_PUBLISH, (tx, scope) => reschedulePost(tx, scope, post(req), req.body)),
  );
  app.post(`${SOCIAL_BASE}/posts/:postId/cancel`, (req) =>
    inSocial(auth, req, SOCIAL_COMPOSE, (tx, scope) => cancelPost(tx, scope, post(req), versionBody.parse(req.body).version)),
  );
  // The owner settles an unclear send (S5); nothing is resent.
  app.post(`${SOCIAL_BASE}/publications/:publicationId/resolve`, (req) =>
    inSocial(auth, req, SOCIAL_APPROVE, (tx, scope) =>
      resolvePublication(tx, scope, z.object({ publicationId: z.uuid() }).passthrough().parse(req.params).publicationId, req.body),
    ),
  );
  app.post(`${SOCIAL_BASE}/posts/:postId/archive`, (req) =>
    inSocial(auth, req, SOCIAL_COMPOSE, (tx, scope) => archivePost(tx, scope, post(req), versionBody.parse(req.body).version)),
  );
};
