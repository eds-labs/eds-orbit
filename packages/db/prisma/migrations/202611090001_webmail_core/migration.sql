-- Webmail module (ADR 0026): mailboxes opened for webmail, per-member grants,
-- webmail sessions and the claim of a message handed to another module.
-- Additive: nothing reads these tables while ORBIT_WEBMAIL is off.

CREATE TABLE "WebmailMailbox" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "emailConnectionId" UUID NOT NULL,
  "displayName" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "sensitive" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebmailMailbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WebmailMailbox_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WebmailMailbox_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "WebmailMailbox_emailConnection_fkey" FOREIGN KEY ("projectId", "emailConnectionId") REFERENCES "Entity"("projectId", "id"),
  CONSTRAINT "WebmailMailbox_emailConnection_key" UNIQUE ("projectId", "emailConnectionId")
);

CREATE TABLE "WebmailMailboxGrant" (
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "mailboxId" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "canRead" BOOLEAN NOT NULL DEFAULT false,
  "canSend" BOOLEAN NOT NULL DEFAULT false,
  "canOrganize" BOOLEAN NOT NULL DEFAULT false,
  "canConvert" BOOLEAN NOT NULL DEFAULT false,
  "canManage" BOOLEAN NOT NULL DEFAULT false,
  "grantedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebmailMailboxGrant_pkey" PRIMARY KEY ("projectId", "mailboxId", "userId"),
  CONSTRAINT "WebmailMailboxGrant_mailbox_fkey" FOREIGN KEY ("projectId", "mailboxId") REFERENCES "WebmailMailbox"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "WebmailMailboxGrant_member_fkey" FOREIGN KEY ("workspaceId", "userId") REFERENCES "WorkspaceMember"("workspaceId", "userId") ON DELETE CASCADE
);
CREATE INDEX "WebmailMailboxGrant_workspaceId_userId_idx" ON "WebmailMailboxGrant"("workspaceId", "userId");

CREATE TABLE "WebmailSession" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "mailboxId" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "authSessionId" TEXT NOT NULL,
  "handoffExpiresAt" TIMESTAMPTZ(3) NOT NULL,
  "handoffConsumedAt" TIMESTAMPTZ(3),
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "lastSeenAt" TIMESTAMPTZ(3),
  "revokedAt" TIMESTAMPTZ(3),
  "revokeReason" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebmailSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WebmailSession_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "WebmailSession_mailbox_fkey" FOREIGN KEY ("projectId", "mailboxId") REFERENCES "WebmailMailbox"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "WebmailSession_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "WebmailSession_projectId_mailboxId_userId_idx" ON "WebmailSession"("projectId", "mailboxId", "userId");
CREATE INDEX "WebmailSession_expiresAt_idx" ON "WebmailSession"("expiresAt");

CREATE TABLE "WebmailConversion" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "mailboxId" UUID NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "mode" TEXT NOT NULL,
  "target" TEXT NOT NULL,
  "attemptId" UUID NOT NULL,
  "leaseUntil" TIMESTAMPTZ(3) NOT NULL,
  "recordId" UUID,
  "folder" TEXT NOT NULL,
  "uid" INTEGER NOT NULL,
  "uidValidity" TEXT NOT NULL,
  "inboundId" UUID,
  "errorCode" TEXT,
  "actorId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebmailConversion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WebmailConversion_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "WebmailConversion_projectId_mailboxId_dedupeKey_key" UNIQUE ("projectId", "mailboxId", "dedupeKey"),
  CONSTRAINT "WebmailConversion_mailbox_fkey" FOREIGN KEY ("projectId", "mailboxId") REFERENCES "WebmailMailbox"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "WebmailConversion_status_check" CHECK ("status" IN ('pending', 'done', 'failed')),
  CONSTRAINT "WebmailConversion_mode_check" CHECK ("mode" IN ('create', 'append'))
);
CREATE INDEX "WebmailConversion_projectId_mailboxId_folder_uidValidity_uid_idx" ON "WebmailConversion"("projectId", "mailboxId", "folder", "uidValidity", "uid");

ALTER TABLE "SupportTicket" ADD COLUMN "importSource" TEXT;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['WebmailMailbox','WebmailMailboxGrant','WebmailSession','WebmailConversion'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY project_scope ON %I
      USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
      WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)$p$, t);
  END LOOP;
END $$;
