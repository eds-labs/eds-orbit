import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { issuesSwitchedOn } from "./gate.ts";
import { erasureSubscriber, issuesHandoffTargets } from "./handoffs.ts";
import { triageQueueSubscriber } from "./triage.ts";
import { syncSubscriber } from "./sync.ts";
import { issuesAttention } from "./attention.ts";
import { issuesJobs } from "./jobs.ts";
import { issuesLinkTypes } from "./links.ts";
import { issuesRoutes } from "./routes.ts";
import {
  ISSUES_HOOK,
  ISSUES_WEBHOOK_PROVIDER,
  issuesWebhook,
  issuesWebhookConnectionProvider,
} from "./sources/webhook.ts";

/** The domain events the module publishes (ADR 0018): ids and keys only. */
export const ISSUES_EVENTS = [
  "issues.report.received",
  "issues.issue.created",
  "issues.issue.updated",
  "issues.issue.status_changed",
  "issues.issue.merged",
  "issues.issue.released",
  "issues.issue.closed",
  "issues.delivery.recorded",
] as const;

/** What the issue center plugs into the platform. */
export const issuesContributions: ModuleContributions = {
  available: issuesSwitchedOn,
  unavailableCode: "ISSUES_DISABLED",
  routes: issuesRoutes,
  linkTypes: issuesLinkTypes,
  events: { publishes: ISSUES_EVENTS, subscribes: [erasureSubscriber, triageQueueSubscriber, syncSubscriber] },
  // Support's hand-in of a ticket (WP3.6).
  handoffs: issuesHandoffTargets,
  // Signed reports from any system or n8n (contract issues.report.v1),
  // only while ORBIT_PUBLIC_INGRESS is on as well.
  connections: { providers: { [ISSUES_WEBHOOK_PROVIDER]: issuesWebhookConnectionProvider } },
  webhooks: { [ISSUES_HOOK]: issuesWebhook },
  jobs: issuesJobs,
  attention: issuesAttention,
};
