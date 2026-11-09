import type { FastifyRequest } from "fastify";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { systemAdminFor } from "../../platform/administration/authz.ts";
import type { RoutesContribution } from "../../platform/http/routes.ts";
import { sessionFor } from "../../platform/tenancy/auth.ts";
import {
  convertInput,
  convertMessage,
  convertOptions,
  convertRecords,
  convertStatus,
  recordsQuery,
  requireConvertable,
  statusQuery,
} from "./convert.ts";
import { webmailSwitchedOn } from "./gate.ts";
import { inWebmail, WEBMAIL_BASE as BASE } from "./http-scope.ts";
import {
  closeMailbox,
  listGrants,
  listMemberMailboxes,
  openMailbox,
  setGrant,
  updateMailbox,
  webmailSettings,
} from "./mailboxes.ts";
import { WEBMAIL_SETTINGS, WEBMAIL_USE } from "./permissions.ts";
import { openSession, revokeMemberSessions } from "./sessions.ts";

const BRIDGE_HOST = "webmail-bridge";
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Installation status, control-plane metadata only. The bridge answers on the
 * private compose network; `probe` is a test seam.
 */
export async function webmailStatus(probe: typeof fetch = fetch): Promise<{
  enabled: boolean;
  originConfigured: boolean;
  bridge: "ok" | "unreachable" | "off";
}> {
  const config = loadConfig();
  const enabled = webmailSwitchedOn();
  const originConfigured = config.WEBMAIL_ORIGIN !== "";
  if (!enabled) return { enabled, originConfigured, bridge: "off" };
  try {
    const response = await probe(
      `http://${BRIDGE_HOST}:${config.WEBMAIL_BRIDGE_PORT}/healthz`,
      { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
    );
    return {
      enabled,
      originConfigured,
      bridge: response.ok ? "ok" : "unreachable",
    };
  } catch {
    return { enabled, originConfigured, bridge: "unreachable" };
  }
}

const mailboxIdOf = (req: FastifyRequest) =>
  (req.params as { mailboxId: string }).mailboxId;

export const webmailRoutes: RoutesContribution = ({ app, auth }) => {
  // Answered in onRequest: the module's preHandler is a 404 while webmail is
  // off for the installation, and "off" is what this route has to report.
  app.get(
    "/api/admin/webmail/status",
    {
      onRequest: async (req, reply) => {
        await systemAdminFor(auth, req);
        return reply.send(await webmailStatus());
      },
    },
    async () => undefined,
  );

  // Mailboxes and sessions.
  app.get(`${BASE}/mailboxes`, (req) =>
    inWebmail(auth, req, WEBMAIL_USE, (tx, scope) =>
      listMemberMailboxes(tx, scope),
    ),
  );
  app.post(`${BASE}/mailboxes/:mailboxId/session`, async (req, reply) => {
    const { session } = await sessionFor(auth, req);
    const opened = await inWebmail(auth, req, WEBMAIL_USE, (tx, scope, p) =>
      openSession(tx, scope, p.mailboxId!, session.id),
    );
    return reply.code(201).send(opened);
  });
  app.delete(`${BASE}/mailboxes/:mailboxId/session`, async (req, reply) => {
    await inWebmail(auth, req, WEBMAIL_USE, (tx, scope, p) =>
      /^[\da-f-]{36}$/i.test(p.mailboxId!)
        ? revokeMemberSessions(tx, scope, p.mailboxId!, scope.userId, "closed")
        : Promise.resolve(0),
    );
    return reply.code(204).send();
  });

  // Handing a message over to another module.
  app.get(`${BASE}/mailboxes/:mailboxId/convert/options`, (req) =>
    inWebmail(auth, req, WEBMAIL_USE, (tx, scope, p) =>
      convertOptions(tx, scope, p.mailboxId!),
    ),
  );
  // Input is parsed after the access check, so a caller who may not be here
  // gets 401 or 404, never a validation error.
  app.get(`${BASE}/mailboxes/:mailboxId/convert/records`, (req) =>
    inWebmail(auth, req, WEBMAIL_USE, (tx, scope, p) =>
      convertRecords(
        tx,
        scope,
        p.mailboxId!,
        recordsQuery.parse(req.query ?? {}),
      ),
    ),
  );
  app.get(`${BASE}/mailboxes/:mailboxId/convert/status`, (req) =>
    inWebmail(auth, req, WEBMAIL_USE, (tx, scope, p) =>
      convertStatus(
        tx,
        scope,
        p.mailboxId!,
        statusQuery.parse(req.query ?? {}),
      ),
    ),
  );
  // The grant is checked first; the IMAP read and the files need no project
  // lock, so the work runs after this transaction has ended.
  app.post(`${BASE}/mailboxes/:mailboxId/convert`, async (req, reply) => {
    const { scope, connectionId } = await inWebmail(
      auth,
      req,
      WEBMAIL_USE,
      async (tx, scope, p) => ({
        scope,
        ...(await requireConvertable(tx, scope, p.mailboxId!)),
      }),
    );
    const result = await convertMessage(
      scope,
      mailboxIdOf(req),
      connectionId,
      convertInput.parse(req.body),
    );
    return reply.code(result.status === "pending" ? 202 : 200).send(result);
  });

  // Settings: opening mailboxes for webmail and granting access.
  app.get(`${BASE}/settings`, (req) =>
    inWebmail(auth, req, WEBMAIL_SETTINGS, (tx, scope) =>
      webmailSettings(tx, scope),
    ),
  );
  app.post(`${BASE}/settings/mailboxes`, async (req, reply) => {
    const opened = await inWebmail(auth, req, WEBMAIL_SETTINGS, (tx, scope) =>
      openMailbox(tx, scope, req.body),
    );
    return reply.code(201).send(opened);
  });
  app.patch(`${BASE}/settings/mailboxes/:mailboxId`, (req) =>
    inWebmail(auth, req, WEBMAIL_SETTINGS, (tx, scope, p) =>
      updateMailbox(tx, scope, p.mailboxId!, req.body),
    ),
  );
  app.delete(`${BASE}/settings/mailboxes/:mailboxId`, async (req, reply) => {
    await inWebmail(auth, req, WEBMAIL_SETTINGS, (tx, scope, p) =>
      closeMailbox(tx, scope, p.mailboxId!),
    );
    return reply.code(204).send();
  });
  app.get(`${BASE}/mailboxes/:mailboxId/grants`, (req) =>
    inWebmail(auth, req, WEBMAIL_USE, (tx, scope, p) =>
      listGrants(tx, scope, p.mailboxId!),
    ),
  );
  app.put(`${BASE}/mailboxes/:mailboxId/grants/:userId`, (req) =>
    inWebmail(auth, req, WEBMAIL_USE, (tx, scope, p) =>
      setGrant(tx, scope, p.mailboxId!, p.userId!, req.body),
    ),
  );
};
