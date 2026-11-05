/**
 * HTTP routes of the proactive layer (ADR 0023, plan WP4.1-WP4.4). All of
 * them answer 404 while ORBIT_PROACTIVE is off.
 *
 * - `GET/PUT /api/assistant/preferences`: the signed-in user's own delivery
 *   preferences in their personal space (notifications, quiet hours,
 *   digest, briefing). Voice settings have their own route.
 * - `GET /api/notifications/summary`: unread counts and the newest notices
 *   across the user's projects, one transaction per project.
 * - `GET /api/notifications/stream`: content-free wake-ups for the badge.
 * - `GET/PUT /api/projects/:projectId/signal-settings`: the project's
 *   signal switches (members read, owners change).
 */
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { authDb, scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { RoutesContribution } from "../http/routes.ts";
import { registeredRegistry } from "../modules/contributions.ts";
import { DomainError } from "../shared.ts";
import { scopeFor, userFor, type Auth } from "../tenancy/auth.ts";
import { ensurePersonalSpace, findPersonalSpace, personalAssistantEnabled } from "../assistant/personal-space.ts";
import { telegramEnabled, telegramStatus } from "../connections/telegram.ts";
import { systemMailConfigured } from "../email/system-mail.ts";
import { realtimeEnabled } from "../realtime/fanout.ts";
import { serveEventStream } from "../realtime/sse.ts";
import { listSignalSettings, saveSignalSettings } from "../signals/settings.ts";
import { proactiveEnabled, readPreferences, savePreferences } from "./preferences.ts";
import { notificationSummary } from "./summary.ts";
import { notificationStream } from "./wake.ts";

export const PROACTIVE_ROUTES = new Set([
  "/api/assistant/preferences",
  "/api/notifications/summary",
  "/api/notifications/stream",
  "/api/projects/:projectId/signal-settings",
]);

const query = z.object({ workspaceId: z.uuid().optional() }).passthrough();

function requireOn() {
  if (!proactiveEnabled()) throw new DomainError("NOT_FOUND", 404);
}

/** The organization a request means: the given one, or the user's first. */
async function workspaceFor(userId: string, req: FastifyRequest) {
  const { workspaceId } = query.parse(req.query ?? {});
  const member = await authDb.workspaceMember.findFirst({
    where: { userId, ...(workspaceId ? { workspaceId } : {}) },
    orderBy: { workspace: { createdAt: "asc" } },
    select: { workspaceId: true },
  });
  if (!member) throw new DomainError("NOT_FOUND", 404);
  return member.workspaceId;
}

/** Runs `work` in the user's own personal space (created on first use). */
async function inPersonalSpace<T>(
  auth: Auth,
  req: FastifyRequest,
  work: (tx: DbTx, scope: Scope) => Promise<T>,
) {
  requireOn();
  if (!personalAssistantEnabled()) throw new DomainError("NOT_FOUND", 404);
  const user = await userFor(auth, req);
  const workspaceId = await workspaceFor(user.id, req);
  const space = await ensurePersonalSpace(workspaceId, user.id, registeredRegistry());
  const scope: Scope = { workspaceId, projectId: space.projectId, userId: user.id, role: "owner" };
  return scoped(workspaceId, space.projectId, (tx) => work(tx, scope));
}

/** What the preferences page shows beside the saved values. */
async function preferencesView(tx: DbTx, scope: Scope) {
  const { preferences, version } = await readPreferences(tx, scope);
  const telegram = telegramEnabled() ? await telegramStatus(tx, scope) : null;
  return {
    personalSpaceId: scope.projectId,
    version,
    preferences,
    channels: {
      // The digest e-mail needs the operator's system sender (D-18).
      systemMail: systemMailConfigured(),
      telegram: telegram ? { available: true, ...telegram } : { available: false, status: "none", linkedAt: null },
    },
  };
}

export const proactiveRoutes: RoutesContribution = ({ app, auth }) => {
  app.get("/api/assistant/preferences", (req) =>
    inPersonalSpace(auth, req, (tx, scope) => preferencesView(tx, scope)),
  );
  app.put("/api/assistant/preferences", (req) =>
    inPersonalSpace(auth, req, async (tx, scope) => {
      await savePreferences(tx, scope, req.body);
      return preferencesView(tx, scope);
    }),
  );

  app.get("/api/notifications/summary", async (req) => {
    requireOn();
    const user = await userFor(auth, req);
    const workspaceId = await workspaceFor(user.id, req);
    return notificationSummary(workspaceId, user.id);
  });

  // Wake-ups only: every message is an empty "changed" event, after which
  // the client reads the summary again. Without a personal space or with
  // Redis down the client polls once a minute instead.
  app.get("/api/notifications/stream", async (req, reply) => {
    requireOn();
    const user = await userFor(auth, req);
    const workspaceId = await workspaceFor(user.id, req);
    const space = await findPersonalSpace(workspaceId, user.id);
    if (!space || !realtimeEnabled()) throw new DomainError("NOT_FOUND", 404);
    await serveEventStream(req, reply, {
      projectId: space.id,
      stream: notificationStream(space.id),
      fallbackPollMs: 60_000,
      replay: async (after) => ({
        events: [{ id: Math.max(Date.now(), (after ?? 0) + 1), event: "changed", data: {} }],
        done: false,
      }),
    });
  });

  app.get("/api/projects/:projectId/signal-settings", async (req) => {
    requireOn();
    const scope = await scopeFor(auth, req, (req.params as { projectId: string }).projectId);
    return scoped(scope.workspaceId, scope.projectId, (tx) => listSignalSettings(tx, scope));
  });
  app.put("/api/projects/:projectId/signal-settings", async (req) => {
    requireOn();
    const scope = await scopeFor(auth, req, (req.params as { projectId: string }).projectId);
    return scoped(scope.workspaceId, scope.projectId, (tx) => saveSignalSettings(tx, scope, req.body));
  });
};
