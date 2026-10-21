import { scoped } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type {
  CustomerContext,
  CustomerContextResult,
} from "../../../../../packages/schemas/src/customer-context.ts";
import {
  customerContextEnabled,
  customerContextTarget,
  verifiedCustomerContextConnection,
} from "../../platform/customer-context/connection.ts";
import {
  lookupCustomerContext,
  type CustomerContextTarget,
} from "../../platform/customer-context/client.ts";
import { audit, data, DomainError } from "../../shared.ts";
import { inboxRulesSchema } from "./settings.ts";

// Customer context for a Support ticket (ADR 0011). Support decides whether
// a lookup may happen at all and for whom; the platform client does the
// signed call. Only a widget ticket of an inbox bound to a verified
// integration, whose contact has exactly one HMAC-verified identity of that
// same inbox, is ever looked up. Every other case is answered locally,
// without a call. Nothing is stored; the audit holds ids and the outcome.

export type TicketCustomerContext = {
  result: CustomerContextResult;
  /** The integration's source system, when one was asked. */
  sourceSystem: string | null;
  checkedAt: string;
};

type Origin = "agent" | "ai" | "tool";

type Prepared =
  | { local: CustomerContextResult; sourceSystem: string | null }
  | {
      target: CustomerContextTarget;
      subject: { id: string; verifiedAt: Date };
      sourceSystem: string;
    };

/** The integration and verified subject of a ticket, or a local answer. */
async function prepare(scope: Scope, ticketId: string): Promise<Prepared> {
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const ticket = await tx.supportTicket.findFirst({
      where: { id: ticketId, projectId: scope.projectId },
    });
    if (!ticket) throw new DomainError("TICKET_NOT_FOUND", 404);
    if (!customerContextEnabled())
      return {
        local: { status: "forbidden", reason: "feature_disabled" },
        sourceSystem: null,
      };
    const inbox = await tx.supportInbox.findFirst({
      where: { id: ticket.inboxId, projectId: scope.projectId },
    });
    const rules = inboxRulesSchema.safeParse(inbox?.rules ?? {});
    const connectionId = rules.success
      ? rules.data.customerContext?.connectionId
      : undefined;
    const connection = connectionId
      ? await verifiedCustomerContextConnection(tx, scope, connectionId)
      : null;
    if (!connection)
      return {
        local: { status: "forbidden", reason: "no_integration" },
        sourceSystem: null,
      };
    const sourceSystem = String(data(connection).sourceSystem);
    // E-mail senders and anonymous visitors are claims, not identities.
    const identities =
      ticket.channel === "widget"
        ? await tx.supportContactIdentity.findMany({
            where: {
              projectId: scope.projectId,
              contactId: ticket.contactId,
              inboxId: ticket.inboxId,
              channel: "widget",
            },
            take: 2,
          })
        : [];
    if (identities.length !== 1)
      return {
        local: {
          status: "identity_unverified",
          reason: "no_verified_identity",
        },
        sourceSystem,
      };
    const identity = identities[0]!;
    let target: CustomerContextTarget;
    try {
      target = customerContextTarget(connection.id, data(connection));
    } catch {
      return {
        local: {
          status: "unavailable",
          reason: "misconfigured",
          retryAfterSeconds: null,
        },
        sourceSystem,
      };
    }
    return {
      target,
      subject: { id: identity.externalUserId, verifiedAt: identity.createdAt },
      sourceSystem,
    };
  });
}

/**
 * Reads the live customer context of a ticket. The caller has checked the
 * member's permission and the support gate. Never throws for a provider
 * problem; a missing ticket is 404.
 */
export async function readTicketCustomerContext(
  scope: Scope,
  ticketId: string,
  origin: Origin,
): Promise<TicketCustomerContext> {
  const prepared = await prepare(scope, ticketId);
  let result: CustomerContextResult;
  let durationMs = 0;
  let connectionId: string | null = null;
  if ("local" in prepared) result = prepared.local;
  else {
    connectionId = prepared.target.connectionId;
    ({ result, durationMs } = await lookupCustomerContext(
      prepared.target,
      prepared.subject,
    ));
  }
  // Inboxes without an integration (or the switch off) leave no trace.
  if (prepared.sourceSystem !== null)
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      audit(tx, scope, "support.customer_context.read", ticketId, {
        ticketId,
        connectionId,
        origin,
        outcome: result.status,
        reason: "reason" in result ? result.reason : null,
        durationMs,
        schemaVersion:
          result.status === "ok" ? result.context.schemaVersion : null,
      }),
    );
  return {
    result,
    sourceSystem: prepared.sourceSystem,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * The result as an agent or a model may see it: the product's own user id
 * and Orbit's integration id are left out; the source system stays.
 */
export function customerContextView(read: TicketCustomerContext) {
  const { result } = read;
  if (result.status !== "ok") return { ...read, result };
  const { customer, source, ...rest } = result.context;
  return {
    ...read,
    result: {
      status: "ok" as const,
      context: {
        ...rest,
        source: { system: source.system },
        customer: { accountStatus: customer.accountStatus },
      },
    },
  };
}

// Questions about plan, features or credits, in English and German. Broad
// on purpose: a false positive costs one read-only lookup, a miss leaves a
// draft without the account facts it needed.
// `\b` and `\w` are ASCII-only even with the `u` flag, so word edges and
// word letters are Unicode letters ("überschritten", "Funktionsfähigkeit").
const words = (alternatives: string) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${alternatives.replaceAll("\\w", "[\\p{L}\\p{N}_]")})(?![\\p{L}\\p{N}_])`,
    "iu",
  );
const NEEDS: Array<[topic: "subscription" | "entitlements" | "usage", RegExp]> =
  [
    [
      "subscription",
      words(
        String.raw`abo(nnement)?s?|subscri\w*|plan|plans|tarif\w*|paket\w*|premium|pro[- ]version|trial|test(phase|zeitraum|version)|kündig\w*|cancel\w*|renew\w*|verlänger\w*|upgrade\w*|downgrade\w*|membership|mitgliedschaft|lizenz\w*|licen[cs]e\w*|expir\w*|abgelaufen|läuft ab`,
      ),
    ],
    [
      "entitlements",
      words(
        String.raw`feature\w*|funktion\w*|freigeschaltet|freischalt\w*|unlock\w*|enabled?|disabled|aktiviert|deaktiviert|verfügbar|unavailable|not available|nicht verfügbar|zugriff|access|berechtigung\w*|permission\w*|locked|gesperrt|greyed out|ausgegraut|kann ich nicht nutzen|can'?t use|cannot use`,
      ),
    ],
    [
      "usage",
      words(
        String.raw`credits?|guthaben|kontingent\w*|limit\w*|quota\w*|verbrauch\w*|usage|nutzung|aufgebraucht|verbraucht|used up|ran out|run out|out of|exceeded|überschritten|reset\w*|zurückgesetzt|remaining|übrig|verbleibend\w*|tokens?|requests? left|anfragen`,
      ),
    ],
  ];

/** The account topics a customer's message asks about (possibly none). */
export function customerContextTopics(text: string) {
  return NEEDS.filter(([, pattern]) => pattern.test(text)).map(
    ([topic]) => topic,
  );
}

// Provider text is data: one line, bounded, quoted.
const quoted = (value: string) =>
  JSON.stringify(value.replace(/\s+/g, " ").trim().slice(0, 120));
const shown = (value: unknown) =>
  value === null || value === undefined ? "unknown" : String(value);
const day = (value: string | null) => (value ? value.slice(0, 10) : "unknown");

/**
 * The account facts as citable evidence lines for a draft (`account:*`),
 * or the single notice `account:status` when they cannot be checked. A
 * null value is written as "unknown", never as 0.
 */
export function customerContextEvidence(read: TicketCustomerContext) {
  const { result } = read;
  if (result.status !== "ok") {
    const why =
      result.status === "unavailable"
        ? `the ${read.sourceSystem ?? "product"} system did not answer (${result.reason})`
        : result.status === "not_found"
          ? "no account was found for this verified customer"
          : result.status === "identity_unverified"
            ? "the customer's identity is not verified for this conversation"
            : "the account cannot be read for this conversation";
    return {
      ok: false,
      ids: ["account:status"],
      lines: [
        `account:status The account status cannot be checked right now: ${why}. Do not guess a plan, a feature state, a limit or a cause.`,
      ],
    };
  }
  const c: CustomerContext = result.context;
  const lines: string[] = [];
  const ids: string[] = [];
  const add = (id: string, text: string) => {
    ids.push(id);
    lines.push(`${id} ${text}`);
  };
  add(
    "account:customer",
    `account status=${c.customer.accountStatus}; source system=${c.source.system}; data as of ${day(c.freshness.dataAsOf)}`,
  );
  if (c.subscription) {
    const s = c.subscription;
    add(
      "account:subscription",
      [
        `subscription status=${s.status}`,
        `plan=${s.plan ? quoted(s.plan.name) : "none"}`,
        `current period ends=${day(s.currentPeriodEnd)}`,
        `trial ends=${day(s.trialEndsAt)}`,
        `cancellation=${s.cancellation.state}`,
        `cancellation effective=${day(s.cancellation.effectiveAt)}`,
      ].join("; "),
    );
  } else
    add(
      "account:subscription",
      `subscription ${c.freshness.availability.subscription === "not_applicable" ? "does not apply to this product" : "cannot be checked right now"}`,
    );
  c.entitlements?.forEach((e, index) =>
    add(
      `account:feature:${index + 1}`,
      `feature ${quoted(e.label)} state=${e.state}; reason=${shown(e.reason)}; via=${shown(e.source)}; expires=${day(e.expiresAt)}`,
    ),
  );
  if (!c.entitlements)
    add(
      "account:features",
      `features ${c.freshness.availability.entitlements === "not_applicable" ? "do not apply to this product" : "cannot be checked right now"}`,
    );
  c.usage?.forEach((u, index) =>
    add(
      `account:usage:${index + 1}`,
      `${quoted(u.label)} (${u.unit}, ${u.period}) used=${shown(u.used)}; limit=${u.unlimited === true ? "unlimited" : shown(u.limit)}; remaining=${u.unlimited === true ? "unlimited" : shown(u.remaining)}; resets=${day(u.resetsAt)}`,
    ),
  );
  if (!c.usage)
    add(
      "account:usage",
      `usage limits ${c.freshness.availability.usage === "not_applicable" ? "do not apply to this product" : "cannot be checked right now"}`,
    );
  return { ok: true, ids, lines };
}
