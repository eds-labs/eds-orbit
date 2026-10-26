import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ConnectionProvider } from "../../../platform/connections/connections.ts";
import type { SignedWebhookProvider } from "../../../platform/modules/contributions.ts";
import { componentKey, ISSUE_TYPES, SEVERITIES } from "../common.ts";
import type { NormalizedReport } from "../reports.ts";

// The generic webhook source (plan §2.4, contract issues.report.v1, see
// docs/integrations/issues-report-v1.md): any system, n8n included, signs
// its report like Orbit's customer context contract. Unknown fields are
// dropped and nothing is fetched from URLs in a payload.

export const ISSUES_WEBHOOK_PROVIDER = "issues_webhook";
/** The provider segment of the public path /api/hooks/issues/…. */
export const ISSUES_HOOK = "issues";
export const ISSUES_INTAKE = "issues_intake";
export const CONTRACT = "issues.report.v1";
/** How far a signed timestamp may be from the receiver's clock. */
export const SKEW_SECONDS = 300;

/** `v1=` + hex HMAC-SHA256(secret, timestamp + "." + rawBody). */
export function signIssuesReport(secret: string, timestamp: string, rawBody: string) {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

/** The contract's body; unknown fields are dropped, never stored. */
export const issuesReportV1 = z.object({
  contract: z.literal(CONTRACT),
  /** The sender's delivery id: one id is one report (idempotent). */
  id: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  title: z.string().trim().min(1).max(200),
  symptoms: z.string().max(4000).default(""),
  type: z.enum(ISSUE_TYPES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  components: z.array(componentKey).max(20).default([]),
  fingerprint: z.string().min(1).max(200).optional(),
  externalRef: z
    .object({
      system: z.string().regex(/^[a-z][a-z0-9_.-]{1,40}$/),
      id: z.string().min(1).max(200),
      url: z.url({ protocol: /^https$/ }).max(500).optional(),
    })
    .optional(),
  environment: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/).optional(),
  release: z.string().regex(/^[A-Za-z0-9._+-]{1,80}$/).optional(),
  diagnostics: z
    .record(z.string().regex(/^[a-z][a-zA-Z0-9_.]{0,40}$/), z.union([z.string().max(200), z.number().finite(), z.boolean()]))
    .optional(),
});

/** The stored report a delivery becomes (before redaction). */
export function normalizeWebhook(
  body: unknown,
  connection: { id: string; sourceKind?: unknown },
): NormalizedReport {
  const input = issuesReportV1.parse(body);
  return {
    sourceKind: connection.sourceKind === "n8n" ? "n8n" : "webhook",
    sourceConnectionId: connection.id,
    externalRef: input.externalRef,
    fingerprint: input.fingerprint,
    title: input.title,
    symptoms: input.symptoms,
    severityHint: input.severity,
    typeHint: input.type,
    componentHints: input.components,
    occurredAt: input.occurredAt ? new Date(input.occurredAt) : undefined,
    environment: input.environment,
    release: input.release,
    diagnostics: input.diagnostics ?? {},
  };
}

/** Signed deliveries reach the platform's public route and the intake job. */
export const issuesWebhook: SignedWebhookProvider = {
  connectionProvider: ISSUES_WEBHOOK_PROVIDER,
  verify({ rawBody, headers, credential, now }) {
    const timestamp = headers["x-orbit-timestamp"] ?? "";
    if (!/^\d{9,11}$/.test(timestamp) || Math.abs(now.getTime() / 1000 - Number(timestamp)) > SKEW_SECONDS)
      return false;
    const sent = Buffer.from(headers["x-orbit-signature"] ?? "");
    const expected = Buffer.from(signIssuesReport(credential, timestamp, rawBody));
    return sent.length === expected.length && timingSafeEqual(sent, expected);
  },
  // The delivery id is part of the signed body.
  messageId({ body }) {
    const id = (body as { id?: unknown } | null)?.id;
    return typeof id === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(id) ? id : null;
  },
  queueClass: ISSUES_INTAKE,
};

/**
 * A project's inbound report source. The issue center creates these
 * connections itself (sources.ts) with a generated signing secret, shown
 * once; there is nothing to check at a provider.
 */
export const issuesWebhookConnectionProvider: ConnectionProvider = {
  scopes: ["project"],
  label: { en: "Issue report webhook", de: "Issue-Webhook" },
  checkUnsupported: "ISSUES_WEBHOOK_NOT_CHECKABLE",
};
