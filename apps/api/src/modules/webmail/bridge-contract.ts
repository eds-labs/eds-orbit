import { z } from "zod";

// The wire contract between the Roundcube plugin (infra/webmail/plugins/
// orbit_bridge) and the internal bridge (ADR 0026), proven by the proof of
// concept: infra/webmail/poc/mock-bridge/contract.json. Every call is a POST
// with `Authorization: Bearer <WEBMAIL_BRIDGE_SECRET>`. The plugin treats any
// non-200 status, transport error or undecodable body as a refusal.

export const WEBMAIL_BRIDGE_PREFIX = "/v1";

export const webmailCapability = z.enum(["read", "send", "organize", "convert"]);
export type WebmailCapability = z.infer<typeof webmailCapability>;

/** A vetted mail server for one request; the only place the password travels. */
export const webmailServerTarget = z.object({
  /** IP address already checked with assertPublicMailHost. */
  host: z.string(),
  /** Host name verified against the server certificate. */
  tlsPeerName: z.string(),
  port: z.number().int(),
  tlsMode: z.enum(["ssl", "tls", "none"]),
  user: z.string(),
  password: z.string(),
});
export type WebmailServerTarget = z.infer<typeof webmailServerTarget>;

export const handoffConsumeRequest = z
  .object({
    token: z.string().max(400),
    /** The Origin header, already matched against APP_ORIGIN by the plugin. */
    origin: z.string().max(300),
  })
  .strict();

export const handoffConsumeOk = z.object({
  ok: z.literal(true),
  handle: z.string(),
  /** The opaque Roundcube user, `mb-<mailboxId>@orbit.invalid`. */
  user: z.string(),
});

export const handoffConsumeError = z.enum([
  "origin_mismatch",
  "token_invalid",
  "token_consumed",
  "token_expired",
]);

export const sessionAuthorizeRequest = z
  .object({
    handle: z.string().max(400),
    /** Audit only; the plugin enforces the action against the capabilities. */
    task: z.string().max(64),
    action: z.string().max(64),
  })
  .strict();

export const sessionAuthorizeOk = z.object({
  ok: z.literal(true),
  capabilities: z.array(webmailCapability),
  /** For the link back into Orbit when the client is not embedded. */
  projectId: z.uuid(),
  /** The mailbox address: the identity and the From check. */
  email: z.string(),
  displayName: z.string(),
  imap: webmailServerTarget,
  smtp: webmailServerTarget,
});

export const sessionAuthorizeError = z.enum([
  "session_unknown",
  "session_revoked",
  "session_expired",
  "not_authorized",
  "mailbox_unavailable",
]);

export const barrierOperation = z.enum([
  "move",
  "delete",
  "mark_deleted",
  "expunge",
  "purge",
]);

export const barrierSelection = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("uids"),
    /** As Roundcube parsed them: "12" or the range "12:40". */
    uids: z.array(z.string().regex(/^\d+(:\d+)?$/)).max(5000),
  }),
  z.object({ type: z.literal("all") }),
]);
export type BarrierSelection = z.infer<typeof barrierSelection>;

export const sessionBarrierRequest = z
  .object({
    handle: z.string().max(400),
    operation: barrierOperation,
    folder: z.string().max(1000),
    selection: barrierSelection,
  })
  .strict();

/** Only `ok` lets the action run. */
export const sessionBarrierResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok") }),
  z.object({ status: z.literal("retry"), reason: z.string() }),
]);
export type SessionBarrierResponse = z.infer<typeof sessionBarrierResponse>;

export const sessionEndRequest = z
  .object({
    handle: z.string().max(400),
    reason: z.enum(["logout", "session_destroy"]),
  })
  .strict();

/** What the embedded client may post to the Orbit page; everything else is ignored. */
export const webmailConvertMessage = z
  .object({
    type: z.literal("orbit.webmail.convert"),
    folder: z.string().max(1000),
    uid: z.number().int().positive(),
    uidValidity: z.number().int().positive(),
  })
  .strict();
