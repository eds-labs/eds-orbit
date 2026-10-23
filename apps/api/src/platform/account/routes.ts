import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { fromNodeHeaders, sessionFor, type Auth } from "../tenancy/auth.ts";
import { DomainError } from "../shared.ts";
import {
  changePassword,
  confirmEmailChange,
  confirmPasswordReset,
  listSessions,
  passwordResetAvailable,
  profile,
  requestEmailChange,
  requestPasswordReset,
  resetRequestInput,
  revokeOtherSessions,
  revokeSession,
  updateProfile,
} from "./service.ts";

// The signed-in user's own account (ADR 0012). 404 while ORBIT_ACCOUNT is
// off (server onRequest hook). The two password-reset routes are public and
// rate-limited per client address and per address asked for.

export const isAccountRoute = (url: string) =>
  url === "/api/account" || url.startsWith("/api/account/");

// At most three reset mails per address and hour, per API instance.
const RESET_PER_HOUR = 3;
const resetRequests = new Map<string, number[]>();
function allowResetFor(email: string) {
  const key = createHash("sha256").update(email.toLowerCase()).digest("hex");
  const now = Date.now();
  const recent = (resetRequests.get(key) ?? []).filter(
    (t) => now - t < 3600 * 1000,
  );
  if (recent.length >= RESET_PER_HOUR) return false;
  recent.push(now);
  resetRequests.set(key, recent);
  if (resetRequests.size > 10_000) resetRequests.clear();
  return true;
}

export function registerAccountRoutes(app: FastifyInstance, auth: Auth) {
  const me = (req: FastifyRequest) => sessionFor(auth, req);
  const headers = (req: FastifyRequest) => fromNodeHeaders(req.headers);

  app.get("/api/account", async (req) => profile((await me(req)).user.id));
  app.patch("/api/account", async (req) =>
    updateProfile((await me(req)).user.id, req.body),
  );
  app.post("/api/account/password", async (req, reply) => {
    const session = await me(req);
    const result = await changePassword(
      auth,
      session.user.id,
      headers(req),
      req.body,
    );
    if (result.setCookies.length) reply.header("set-cookie", result.setCookies);
    return { changed: true };
  });
  app.get("/api/account/sessions", async (req) => {
    const session = await me(req);
    return listSessions(session.user.id, session.session.id);
  });
  app.delete("/api/account/sessions/:sessionId", async (req, reply) => {
    const session = await me(req);
    const { sessionId } = req.params as { sessionId: string };
    if (sessionId === session.session.id)
      throw new DomainError("CURRENT_SESSION", 409);
    await revokeSession(session.user.id, sessionId);
    return reply.code(204).send();
  });
  app.post("/api/account/sessions/revoke-others", async (req) => {
    const session = await me(req);
    return revokeOtherSessions(session.user.id, session.session.id);
  });
  app.post("/api/account/email", async (req) => {
    const session = await me(req);
    return requestEmailChange(auth, session.user.id, headers(req), req.body);
  });
  app.post("/api/account/email/confirm", async (req) =>
    confirmEmailChange((await me(req)).user.id, req.body),
  );

  const publicLimit = {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  };
  app.post(
    "/api/account/password-reset/request",
    publicLimit,
    async (req, reply) => {
      const { email } = resetRequestInput.parse(req.body);
      if (!passwordResetAvailable())
        throw new DomainError("PASSWORD_RESET_UNAVAILABLE", 404);
      // Over the limit the answer stays the same; only the mail is skipped.
      if (allowResetFor(email))
        await requestPasswordReset(auth, { email }, (code) =>
          req.log.warn({ code }, "password reset mail"),
        );
      return reply.code(202).send({ requested: true });
    },
  );
  app.post("/api/account/password-reset/confirm", publicLimit, async (req) =>
    confirmPasswordReset(auth, req.body),
  );
}
