import type { PlatformDeclaration } from "../../../../../packages/module-contracts/src/index.ts";
import { platformPermissions } from "../tenancy/permissions.ts";

/**
 * Entity kinds and tables the Orbit Platform owns (plans/orbit-modularization
 * 04 §2.3). Every other kind and table belongs to exactly one module.
 */
export const platformDeclaration: PlatformDeclaration = {
  entityKinds: [
    { kind: "orbit_tasks", description: "User-private delegated assistant tasks", exported: false },
    { kind: "jobs", description: "Durable jobs dispatched through the outbox" },
    { kind: "exceptions", description: "Open operational exceptions by code" },
    {
      kind: "action_requests",
      description: "Hash-bound approval requests (ADR 0008)",
    },
    { kind: "budget_runs", description: "Reservations grouped per paid run" },
    {
      kind: "ai_spend_policies",
      description: "The project's AI spending authority (ADR 0015)",
    },
    {
      kind: "openai_configuration",
      description: "Per-project AI provider keys and routes",
    },
    { kind: "chat_archives", description: "Archived assistant conversations" },
    {
      kind: "workflow_runs",
      description: "Automation workflow runs: status and codes, no payload (ADR 0014)",
      exported: false,
    },
    {
      kind: "connectors",
      description: "Encrypted provider credentials and capability states",
      exported: false,
    },
    {
      kind: "email_messages",
      description: "Outbound e-mail and its delivery state (WP4.7)",
      exported: false,
    },
    {
      kind: "inbound_emails",
      description: "Normalized inbound e-mail; the raw message is a file",
      exported: false,
    },
    {
      kind: "email_inbound_state",
      description: "The last fetched IMAP UID per mailbox",
      exported: false,
    },
    {
      kind: "telegram_connections",
      description: "The owner's notification bot",
      exported: false,
    },
    {
      kind: "drive_connection",
      description: "Google Drive OAuth connection",
      exported: false,
    },
    { kind: "drive_storage", description: "Google Drive folder layout" },
    {
      kind: "drive_oauth_state",
      description: "Pending Google Drive OAuth state",
      exported: false,
    },
    {
      kind: "public_sessions",
      description:
        "Sessions of public API clients, with hashed tokens (WP4.2b)",
      exported: false,
    },
    {
      kind: "inbound_webhooks",
      description:
        "Signed provider webhooks received through the platform (WP4.2)",
      exported: false,
    },
  ],
  tables: [
    "_prisma_migrations",
    "user",
    "session",
    "account",
    "verification",
    // OAuth authorization server for MCP clients (Track M, WP-M1): Better
    // Auth's provider tables and Orbit's grants, all in the auth table set.
    "jwks",
    "oauthClient",
    "oauthAccessToken",
    "oauthRefreshToken",
    "oauthConsent",
    "oauthClientAssertion",
    "oauthResource",
    "oauthClientResource",
    "McpGrant",
    "McpGrantEvent",
    // System administration (ADR 0013): invitations and the system audit.
    "Invitation",
    "InvitationProjectGrant",
    "SystemAuditEvent",
    // Central connections, AI profiles and knowledge shares (ADR 0014).
    "Connection",
    "ConnectionSecret",
    "ConnectionGrant",
    "SpendCounter",
    "AiProfile",
    "AiModelPrice",
    "OrganizationAiBudget",
    "OrganizationSpendCounter",
    "KnowledgeShare",
    "WorkflowBinding",
    "Workspace",
    "WorkspaceMember",
    "Project",
    "ProjectMember",
    "ProjectMemberModuleRole",
    "PublicClientKey",
    "File",
    "FileBlob",
    "Notification",
    "NotificationPreference",
    "ProjectModule",
    "Entity",
    "EntityVersion",
    "Outbox",
    // Object links and domain events (ADR 0016).
    "ObjectLink",
    "DomainEvent",
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
