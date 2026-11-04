/**
 * HTTP routes of voice in the personal assistant (ADR 0024, plan Phase 4
 * WP4.6/WP4.7). Every route answers 404 NOT_FOUND while ORBIT_VOICE is off,
 * before authentication or reading a body, and acts only on the signed-in
 * user's own personal space (`workspaceId` in the query, or the user's first
 * organization); no route names someone else's space.
 *
 * - GET/PUT /api/assistant/voice-settings: availability, limits and the
 *   user's auto-send and auto-read switches.
 * - POST /api/assistant/transcriptions: the raw recording as the body
 *   (Content-Type audio/webm or audio/mp4, at most 2 MB), `?language=xx`
 *   optional. Orbit has no multipart plugin; like the platform file upload
 *   the bytes arrive as the body and are held in memory only.
 * - POST /api/assistant/speech {messageId}: the streamed audio of one of
 *   the user's assistant messages.
 */
import type { FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import { authDb, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  SPEECH_MAX_BYTES,
  speechMimeOf,
} from "../../../../../packages/ai/src/index.ts";
import type { RoutesContribution } from "../http/routes.ts";
import { registeredRegistry } from "../modules/contributions.ts";
import { DomainError } from "../shared.ts";
import { userFor, type Auth } from "../tenancy/auth.ts";
import { userScoped } from "../tenancy/scope.ts";
import { ensurePersonalSpace } from "./personal-space.ts";
import {
  DEFAULT_VOICE_SETTINGS,
  readVoiceSettings,
  saveVoiceSettings,
  speak,
  transcribe,
  voiceEnabled,
  voiceLimits,
  voiceReadiness,
  voiceRefusal,
} from "./voice.ts";

export const VOICE_ROUTES = {
  settings: "/api/assistant/voice-settings",
  transcriptions: "/api/assistant/transcriptions",
  speech: "/api/assistant/speech",
} as const;

const query = z.object({ workspaceId: z.uuid().optional() }).passthrough();
const languageQuery = z
  .object({
    language: z
      .string()
      .regex(/^[a-z]{2}$/)
      .optional(),
  })
  .passthrough();
const speechBody = z.object({ messageId: z.uuid() }).strict();
const VOICE_RATE = { rateLimit: { max: 20, timeWindow: "1 minute" } };

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

const refusalStatus = (code: string) =>
  code === "VOICE_DISABLED" ||
  code === "WORKSPACE_FORBIDDEN" ||
  code === "ASSISTANT_DISABLED"
    ? 404
    : 403;

/**
 * The scope of the user's own personal space after every voice gate; the
 * refusal code when `soft` and a gate other than the flag refuses.
 */
async function voiceScope(auth: Auth, req: FastifyRequest, soft = false) {
  if (!voiceEnabled()) throw new DomainError("NOT_FOUND", 404);
  const user = await userFor(auth, req);
  const workspaceId = await workspaceFor(user.id, req);
  const refusal = await voiceRefusal(workspaceId, user.id);
  if (refusal) {
    if (soft && refusalStatus(refusal) === 403) return { refusal, workspaceId };
    throw new DomainError(
      refusalStatus(refusal) === 404 ? "NOT_FOUND" : refusal,
      refusalStatus(refusal),
    );
  }
  const space = await ensurePersonalSpace(
    workspaceId,
    user.id,
    registeredRegistry(),
  );
  const scope: Scope = {
    workspaceId,
    projectId: space.projectId,
    userId: user.id,
    role: "owner",
  };
  return { scope, workspaceId };
}

async function inVoiceSpace<T>(
  auth: Auth,
  req: FastifyRequest,
  work: (tx: DbTx, scope: Scope) => Promise<T>,
) {
  const { scope } = await voiceScope(auth, req);
  return userScoped(scope!, (tx) => work(tx, scope!));
}

const uploadScope = new WeakMap<object, Scope>();

export const voiceRoutes: RoutesContribution = ({ app, auth }) => {
  app.get(VOICE_ROUTES.settings, async (req) => {
    const gated = await voiceScope(auth, req, true);
    if (!gated.scope)
      return {
        available: false,
        workspaceId: gated.workspaceId,
        reason: gated.refusal,
        settings: DEFAULT_VOICE_SETTINGS,
        limits: voiceLimits,
      };
    const scope = gated.scope;
    return userScoped(scope, async (tx) => ({
      available: true,
      workspaceId: scope.workspaceId,
      settings: await readVoiceSettings(tx, scope),
      limits: voiceLimits,
      ...(await voiceReadiness(tx, scope)),
    }));
  });

  app.put(VOICE_ROUTES.settings, (req) =>
    inVoiceSpace(auth, req, (tx, scope) =>
      saveVoiceSettings(tx, scope, req.body),
    ),
  );

  app.register(async (child) => {
    // The recording arrives as raw bytes, counted while it streams in and
    // stopped with 413 at 2 MB. Only the allowed recording types parse.
    child.addContentTypeParser(
      ["audio/webm", "audio/mp4"],
      { parseAs: "buffer", bodyLimit: SPEECH_MAX_BYTES },
      (_req, body, done) => done(null, body),
    );
    child.post(
      VOICE_ROUTES.transcriptions,
      {
        bodyLimit: SPEECH_MAX_BYTES,
        config: VOICE_RATE,
        // Flag, session, gates, type and declared size before a byte of the
        // body is read.
        onRequest: async (req) => {
          const { scope } = await voiceScope(auth, req);
          if (!speechMimeOf(req.headers["content-type"]))
            throw new DomainError("SPEECH_FORMAT_UNSUPPORTED", 415);
          const length = Number(req.headers["content-length"] ?? 0);
          if (length > SPEECH_MAX_BYTES)
            throw new DomainError("SPEECH_TOO_LARGE", 413);
          uploadScope.set(req, scope!);
        },
      },
      async (req, reply) => {
        const scope = uploadScope.get(req);
        const mime = speechMimeOf(req.headers["content-type"]);
        if (!scope || !mime || !Buffer.isBuffer(req.body) || !req.body.length)
          throw new DomainError("SPEECH_UNREADABLE", 422);
        const { language } = languageQuery.parse(req.query ?? {});
        const controller = new AbortController();
        // The client went away before the answer: the provider call stops.
        const abort = () => {
          if (!reply.raw.writableFinished) controller.abort();
        };
        reply.raw.once("close", abort);
        try {
          const result = await transcribe(
            scope,
            { audio: req.body, mime, ...(language ? { language } : {}) },
            controller.signal,
          );
          return reply.header("cache-control", "no-store").send(result);
        } finally {
          reply.raw.off("close", abort);
        }
      },
    );
  });

  app.post(VOICE_ROUTES.speech, { config: VOICE_RATE }, async (req, reply) => {
    const { scope } = await voiceScope(auth, req);
    const { messageId } = speechBody.parse(req.body ?? {});
    const controller = new AbortController();
    // The client stopped listening: the provider stream is cancelled too.
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    const spoken = await speak(scope!, messageId, controller.signal);
    return reply
      .header("content-type", spoken.mime)
      .header("cache-control", "no-store")
      .header("x-orbit-speech-characters", String(spoken.characters))
      .header("x-orbit-speech-truncated", String(spoken.truncated))
      .send(Readable.from(spoken.audio));
  });
};
