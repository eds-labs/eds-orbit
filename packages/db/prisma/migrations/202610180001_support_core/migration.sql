-- Support module core (Phase 5, WP5.1; plans/orbit-modularization 06 §3.1).
-- Seven project tables like "File": the business role reads and writes them
-- within the project scope (FORCE RLS). Foreign key checks bypass RLS, so
-- every reference between support rows is a composite ("projectId", id) key:
-- a row can only point at rows of its own project. Additive; nothing existing
-- changes except a new unique key on "File" ("projectId", "id") that
-- attachments reference. Message text never leaves these tables (Q-12a).

ALTER TABLE "File" ADD CONSTRAINT "File_projectId_id_key" UNIQUE ("projectId", "id");

CREATE TABLE "SupportInbox" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "channels" TEXT[] NOT NULL,
  "emailAddress" TEXT,
  "allowedOrigins" TEXT[] NOT NULL DEFAULT '{}',
  -- The widget's HMAC secret, encrypted with the credential key; never read back.
  "widgetSecretEnc" TEXT,
  -- The platform public client key of the widget (WP4.2b), linked in WP5.4.
  "publicClientKeyId" UUID,
  "defaultCategory" TEXT,
  "assignmentPolicy" TEXT NOT NULL DEFAULT 'unassigned',
  "defaultAssigneeUserId" TEXT,
  "language" TEXT NOT NULL DEFAULT 'en',
  "aiMode" TEXT NOT NULL DEFAULT 'off',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archivedAt" TIMESTAMPTZ(3),
  CONSTRAINT "SupportInbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportInbox_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SupportInbox_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "SupportInbox_channels_check" CHECK (cardinality("channels") > 0 AND "channels" <@ ARRAY['email','widget']::TEXT[]),
  CONSTRAINT "SupportInbox_assignmentPolicy_check" CHECK ("assignmentPolicy" IN ('unassigned','round_robin','fixed')),
  CONSTRAINT "SupportInbox_language_check" CHECK ("language" IN ('en','de')),
  CONSTRAINT "SupportInbox_aiMode_check" CHECK ("aiMode" IN ('off','draft'))
);
CREATE INDEX "SupportInbox_workspaceId_projectId_idx" ON "SupportInbox"("workspaceId", "projectId");

CREATE TABLE "SupportContact" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "name" TEXT,
  "email" TEXT,
  "locale" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Tombstone: the contact is gone for every reader; deletion follows (WP5.8).
  "deletedAt" TIMESTAMPTZ(3),
  CONSTRAINT "SupportContact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportContact_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SupportContact_projectId_id_key" UNIQUE ("projectId", "id")
);
CREATE UNIQUE INDEX "SupportContact_projectId_email_key" ON "SupportContact"("projectId", lower("email")) WHERE "email" IS NOT NULL AND "deletedAt" IS NULL;

CREATE TABLE "SupportContactIdentity" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "contactId" UUID NOT NULL,
  "inboxId" UUID NOT NULL,
  "channel" TEXT NOT NULL,
  -- The host app's user id, verified by the widget's HMAC.
  "externalUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportContactIdentity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportContactIdentity_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SupportContactIdentity_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "SupportContactIdentity_contact_fkey" FOREIGN KEY ("projectId", "contactId") REFERENCES "SupportContact"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "SupportContactIdentity_inbox_fkey" FOREIGN KEY ("projectId", "inboxId") REFERENCES "SupportInbox"("projectId", "id") ON DELETE RESTRICT,
  CONSTRAINT "SupportContactIdentity_external_key" UNIQUE ("projectId", "inboxId", "channel", "externalUserId")
);

CREATE TABLE "SupportTicket" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  -- Per project, allocated under the project lock.
  "number" INTEGER NOT NULL,
  "inboxId" UUID NOT NULL,
  "contactId" UUID NOT NULL,
  "subject" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'new',
  "priority" TEXT NOT NULL DEFAULT 'normal',
  "category" TEXT,
  "tags" TEXT[] NOT NULL DEFAULT '{}',
  "assigneeUserId" TEXT,
  "channel" TEXT NOT NULL,
  "firstResponseDueAt" TIMESTAMPTZ(3),
  "resolutionDueAt" TIMESTAMPTZ(3),
  "firstRespondedAt" TIMESTAMPTZ(3),
  "resolvedAt" TIMESTAMPTZ(3),
  "closedAt" TIMESTAMPTZ(3),
  "aiState" TEXT NOT NULL DEFAULT 'none',
  "lastCustomerMessageAt" TIMESTAMPTZ(3),
  "mergedIntoTicketId" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportTicket_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SupportTicket_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "SupportTicket_projectId_number_key" UNIQUE ("projectId", "number"),
  CONSTRAINT "SupportTicket_number_check" CHECK ("number" > 0),
  CONSTRAINT "SupportTicket_inbox_fkey" FOREIGN KEY ("projectId", "inboxId") REFERENCES "SupportInbox"("projectId", "id") ON DELETE RESTRICT,
  CONSTRAINT "SupportTicket_contact_fkey" FOREIGN KEY ("projectId", "contactId") REFERENCES "SupportContact"("projectId", "id") ON DELETE RESTRICT,
  CONSTRAINT "SupportTicket_merged_fkey" FOREIGN KEY ("projectId", "mergedIntoTicketId") REFERENCES "SupportTicket"("projectId", "id") ON DELETE SET NULL ("mergedIntoTicketId"),
  CONSTRAINT "SupportTicket_status_check" CHECK ("status" IN ('new','open','pending_customer','pending_internal','resolved','closed')),
  CONSTRAINT "SupportTicket_priority_check" CHECK ("priority" IN ('low','normal','high','urgent')),
  CONSTRAINT "SupportTicket_aiState_check" CHECK ("aiState" IN ('none','ai_handling','handed_off')),
  CONSTRAINT "SupportTicket_channel_check" CHECK ("channel" IN ('email','widget'))
);
CREATE INDEX "SupportTicket_projectId_status_assigneeUserId_idx" ON "SupportTicket"("projectId", "status", "assigneeUserId");
CREATE INDEX "SupportTicket_projectId_inboxId_status_idx" ON "SupportTicket"("projectId", "inboxId", "status");
CREATE INDEX "SupportTicket_projectId_contactId_idx" ON "SupportTicket"("projectId", "contactId");
CREATE INDEX "SupportTicket_projectId_firstResponseDueAt_idx" ON "SupportTicket"("projectId", "firstResponseDueAt");
CREATE INDEX "SupportTicket_projectId_resolutionDueAt_idx" ON "SupportTicket"("projectId", "resolutionDueAt");

CREATE TABLE "SupportMessage" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "ticketId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "authorContactId" UUID,
  "authorUserId" TEXT,
  "agentRunId" UUID,
  "bodyText" TEXT NOT NULL,
  -- Sanitized before it is stored (WP5.3).
  "bodyHtml" TEXT,
  "channel" TEXT NOT NULL,
  -- The provider's message id (e-mail Message-ID), for idempotency.
  "externalId" TEXT,
  "deliveryState" TEXT,
  "visibleToCustomer" BOOLEAN NOT NULL,
  "searchVector" tsvector,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportMessage_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SupportMessage_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "SupportMessage_ticket_fkey" FOREIGN KEY ("projectId", "ticketId") REFERENCES "SupportTicket"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "SupportMessage_author_fkey" FOREIGN KEY ("projectId", "authorContactId") REFERENCES "SupportContact"("projectId", "id") ON DELETE SET NULL ("authorContactId"),
  CONSTRAINT "SupportMessage_external_key" UNIQUE ("projectId", "channel", "externalId"),
  CONSTRAINT "SupportMessage_kind_check" CHECK ("kind" IN ('customer','agent_reply','internal_note','ai_draft','ai_reply','system')),
  -- Internal notes and AI drafts are never shown to the customer.
  CONSTRAINT "SupportMessage_internal_check" CHECK ("kind" NOT IN ('internal_note','ai_draft') OR NOT "visibleToCustomer"),
  CONSTRAINT "SupportMessage_deliveryState_check" CHECK ("deliveryState" IS NULL OR "deliveryState" IN ('pending','sent','not_sent','rejected','unknown','delivered')),
  CONSTRAINT "SupportMessage_channel_check" CHECK ("channel" IN ('email','widget','internal'))
);
CREATE INDEX "SupportMessage_projectId_ticketId_createdAt_idx" ON "SupportMessage"("projectId", "ticketId", "createdAt");
CREATE INDEX "SupportMessage_searchVector_idx" ON "SupportMessage" USING GIN ("searchVector");
-- Full-text search over messages in any language: the 'simple' configuration.
CREATE FUNCTION support_message_search_vector() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" := to_tsvector('simple'::regconfig, NEW."bodyText");
  RETURN NEW;
END $$;
CREATE TRIGGER support_message_search_vector BEFORE INSERT OR UPDATE OF "bodyText" ON "SupportMessage"
  FOR EACH ROW EXECUTE FUNCTION support_message_search_vector();

CREATE TABLE "SupportAttachment" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "messageId" UUID NOT NULL,
  "fileId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "mime" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "scanState" TEXT NOT NULL DEFAULT 'not_scanned',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportAttachment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportAttachment_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SupportAttachment_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "SupportAttachment_message_fkey" FOREIGN KEY ("projectId", "messageId") REFERENCES "SupportMessage"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "SupportAttachment_file_fkey" FOREIGN KEY ("projectId", "fileId") REFERENCES "File"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "SupportAttachment_size_check" CHECK ("size" >= 0),
  CONSTRAINT "SupportAttachment_scanState_check" CHECK ("scanState" IN ('not_scanned','clean','blocked'))
);
CREATE INDEX "SupportAttachment_projectId_messageId_idx" ON "SupportAttachment"("projectId", "messageId");

CREATE TABLE "SupportTicketEvent" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "ticketId" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "actorKind" TEXT NOT NULL,
  "actorId" TEXT,
  -- Field values only (status, priority, assignee, category); never message text.
  "before" JSONB NOT NULL DEFAULT '{}',
  "after" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportTicketEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportTicketEvent_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SupportTicketEvent_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "SupportTicketEvent_ticket_fkey" FOREIGN KEY ("projectId", "ticketId") REFERENCES "SupportTicket"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "SupportTicketEvent_actorKind_check" CHECK ("actorKind" IN ('user','contact','system','ai'))
);
CREATE INDEX "SupportTicketEvent_projectId_ticketId_createdAt_idx" ON "SupportTicketEvent"("projectId", "ticketId", "createdAt");

ALTER TABLE "SupportInbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupportInbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "SupportInbox"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

ALTER TABLE "SupportContact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupportContact" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "SupportContact"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

ALTER TABLE "SupportContactIdentity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupportContactIdentity" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "SupportContactIdentity"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

ALTER TABLE "SupportTicket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupportTicket" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "SupportTicket"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

ALTER TABLE "SupportMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupportMessage" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "SupportMessage"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

ALTER TABLE "SupportAttachment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupportAttachment" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "SupportAttachment"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

ALTER TABLE "SupportTicketEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupportTicketEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "SupportTicketEvent"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
