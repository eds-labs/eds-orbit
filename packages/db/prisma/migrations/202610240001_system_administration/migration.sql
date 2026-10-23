-- System administration, invitations and account self-service (ADR 0013).
-- Additive only: new columns get defaults, nobody is granted the
-- administrator role here (the first one comes from the audited CLI or
-- from /api/setup on a fresh installation).
-- Down path before the first administrative action: drop the three new
-- tables and the added columns.

-- Better Auth admin plugin fields. role is 'user' or 'admin'; banned users
-- cannot sign in and are refused by every membership check.
ALTER TABLE "user" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'user';
ALTER TABLE "user" ADD COLUMN "banned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "user" ADD COLUMN "banReason" TEXT;
ALTER TABLE "user" ADD COLUMN "banExpires" TIMESTAMPTZ(3);
-- Personal interface language; null follows the browser.
ALTER TABLE "user" ADD COLUMN "locale" TEXT;
ALTER TABLE "user" ADD CONSTRAINT "user_role_check" CHECK ("role" IN ('user','admin'));
ALTER TABLE "user" ADD CONSTRAINT "user_locale_check" CHECK ("locale" IS NULL OR "locale" IN ('en','de'));
-- Required by the plugin schema; Orbit never offers impersonation.
ALTER TABLE "session" ADD COLUMN "impersonatedBy" TEXT;

-- CreateTable
CREATE TABLE "Invitation" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "workspaceId" UUID NOT NULL,
    "workspaceRole" TEXT NOT NULL,
    "invitedBy" TEXT NOT NULL,
    "locale" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3),
    "acceptedUserId" TEXT,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Invitation_workspaceRole_check" CHECK ("workspaceRole" IN ('owner','viewer')),
    CONSTRAINT "Invitation_email_lower" CHECK ("email" = lower("email"))
);

-- CreateTable
CREATE TABLE "InvitationProjectGrant" (
    "invitationId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "moduleRoles" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "InvitationProjectGrant_pkey" PRIMARY KEY ("invitationId","projectId"),
    CONSTRAINT "InvitationProjectGrant_role_check" CHECK ("role" IN ('owner','editor','viewer'))
);

-- CreateTable
CREATE TABLE "SystemAuditEvent" (
    "id" UUID NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "workspaceId" UUID,
    "projectId" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");
CREATE INDEX "Invitation_workspaceId_email_idx" ON "Invitation"("workspaceId", "email");
CREATE INDEX "Invitation_email_idx" ON "Invitation"("email");
-- One open invitation per address and organization; history is unlimited.
CREATE UNIQUE INDEX "Invitation_one_open_key" ON "Invitation"("workspaceId", "email") WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL;
CREATE INDEX "InvitationProjectGrant_workspaceId_projectId_idx" ON "InvitationProjectGrant"("workspaceId", "projectId");
CREATE INDEX "SystemAuditEvent_createdAt_idx" ON "SystemAuditEvent"("createdAt");
CREATE INDEX "SystemAuditEvent_targetId_createdAt_idx" ON "SystemAuditEvent"("targetId", "createdAt");
CREATE INDEX "SystemAuditEvent_actorId_createdAt_idx" ON "SystemAuditEvent"("actorId", "createdAt");

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InvitationProjectGrant" ADD CONSTRAINT "InvitationProjectGrant_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "Invitation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InvitationProjectGrant" ADD CONSTRAINT "InvitationProjectGrant_workspaceId_projectId_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The system audit log is append-only for every role, the owner included.
CREATE FUNCTION orbit_system_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SystemAuditEvent is append-only';
END;
$$;
CREATE TRIGGER system_audit_append_only BEFORE UPDATE OR DELETE ON "SystemAuditEvent" FOR EACH ROW EXECUTE FUNCTION orbit_system_audit_append_only();
