import type { PlatformDeclaration } from "../../../../../packages/module-contracts/src/index.ts";
import { platformPermissions } from "../tenancy/permissions.ts";

/**
 * Entity kinds and tables the Orbit Platform owns (plans/orbit-modularization
 * 04 §2.3). Every other kind and table belongs to exactly one module.
 */
export const platformDeclaration: PlatformDeclaration = {
  entityKinds: [
    { kind: "jobs", description: "Durable jobs dispatched through the outbox" },
    { kind: "exceptions", description: "Open operational exceptions by code" },
    {
      kind: "action_requests",
      description: "Hash-bound approval requests (ADR 0008)",
    },
    { kind: "budget_runs", description: "Reservations grouped per paid run" },
    {
      kind: "openai_configuration",
      description: "Per-project AI provider keys and routes",
    },
    { kind: "chat_archives", description: "Archived assistant conversations" },
    {
      kind: "connectors",
      description: "Encrypted provider credentials and capability states",
    },
    {
      kind: "telegram_connections",
      description: "The owner's notification bot",
    },
    { kind: "drive_connection", description: "Google Drive OAuth connection" },
    { kind: "drive_storage", description: "Google Drive folder layout" },
    {
      kind: "drive_oauth_state",
      description: "Pending Google Drive OAuth state",
    },
  ],
  tables: [
    "_prisma_migrations",
    "user",
    "session",
    "account",
    "verification",
    "Workspace",
    "WorkspaceMember",
    "Project",
    "ProjectMember",
    "ProjectModule",
    "Entity",
    "EntityVersion",
    "Outbox",
    "BudgetReservation",
    "AuditEvent",
    "AgentRun",
    "AgentSpan",
    "ChatConversation",
    "ChatMessage",
    "ChatRun",
    "ChatProposal",
  ],
  permissions: platformPermissions,
};
