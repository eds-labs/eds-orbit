import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Auth } from "../tenancy/auth.ts";
import { scopeFor } from "../tenancy/auth.ts";
import {
  markRead,
  myNotifications,
  myPreferences,
  setMyPreferences,
} from "./members.ts";

// A member's own notifications and preferences (WP4.7). Every member may
// read and change only their own; row-level security enforces it as well.
// 404 while ORBIT_NOTIFICATIONS is off (the server's onRequest hook).

export const NOTIFICATION_ROUTES = new Set([
  "/api/projects/:projectId/notifications",
  "/api/projects/:projectId/notifications/read-all",
  "/api/projects/:projectId/notifications/:notificationId/read",
  "/api/projects/:projectId/notification-preferences",
]);

export function registerNotificationRoutes(app: FastifyInstance, auth: Auth) {
  const member = (req: { params: unknown }) =>
    scopeFor(
      auth,
      req as never,
      (req.params as { projectId: string }).projectId,
    );
  app.get("/api/projects/:projectId/notifications", async (req) =>
    myNotifications(await member(req)),
  );
  app.post("/api/projects/:projectId/notifications/read-all", async (req) =>
    markRead(await member(req), null),
  );
  app.post(
    "/api/projects/:projectId/notifications/:notificationId/read",
    async (req) => {
      const scope = await member(req);
      const { notificationId } = req.params as { notificationId: string };
      return markRead(scope, z.uuid().parse(notificationId));
    },
  );
  app.get("/api/projects/:projectId/notification-preferences", async (req) =>
    myPreferences(await member(req)),
  );
  app.put("/api/projects/:projectId/notification-preferences", async (req) =>
    setMyPreferences(await member(req), req.body),
  );
}
