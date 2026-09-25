-- Add private project conversations without changing existing business rows.
CREATE TABLE "ChatConversation" (
  "id" UUID PRIMARY KEY,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL DEFAULT 'New conversation',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ChatConversation_workspaceId_projectId_id_key" UNIQUE ("workspaceId", "projectId", "id"),
  CONSTRAINT "ChatConversation_workspaceId_projectId_id_userId_key" UNIQUE ("workspaceId", "projectId", "id", "userId"),
  CONSTRAINT "ChatConversation_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE
);
CREATE INDEX "ChatConversation_workspaceId_projectId_userId_updatedAt_idx" ON "ChatConversation"("workspaceId", "projectId", "userId", "updatedAt");

CREATE TABLE "ChatMessage" (
  "id" UUID PRIMARY KEY,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "conversationId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "role" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "cards" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatMessage_conversationId_sequence_key" UNIQUE ("conversationId", "sequence"),
  CONSTRAINT "ChatMessage_conversation_fkey" FOREIGN KEY ("workspaceId", "projectId", "conversationId", "userId") REFERENCES "ChatConversation"("workspaceId", "projectId", "id", "userId") ON DELETE CASCADE,
  CONSTRAINT "ChatMessage_role_check" CHECK ("role" IN ('user','assistant'))
);
CREATE INDEX "ChatMessage_workspaceId_projectId_userId_conversationId_idx" ON "ChatMessage"("workspaceId", "projectId", "userId", "conversationId");

CREATE TABLE "ChatRun" (
  "id" UUID PRIMARY KEY,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "conversationId" UUID NOT NULL,
  "clientRequestId" TEXT NOT NULL,
  "jobId" UUID,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "partialText" TEXT NOT NULL DEFAULT '',
  "sequence" INTEGER NOT NULL DEFAULT 0,
  "errorCode" TEXT,
  "reservationId" UUID,
  "transmittedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ChatRun_conversationId_clientRequestId_key" UNIQUE ("conversationId", "clientRequestId"),
  CONSTRAINT "ChatRun_conversation_fkey" FOREIGN KEY ("workspaceId", "projectId", "conversationId", "userId") REFERENCES "ChatConversation"("workspaceId", "projectId", "id", "userId") ON DELETE CASCADE,
  CONSTRAINT "ChatRun_status_check" CHECK ("status" IN ('queued','running','succeeded','blocked','failed','canceled'))
);
CREATE INDEX "ChatRun_workspaceId_projectId_userId_conversationId_idx" ON "ChatRun"("workspaceId", "projectId", "userId", "conversationId");

CREATE TABLE "ChatProposal" (
  "id" UUID PRIMARY KEY,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "conversationId" UUID NOT NULL,
  "groupId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "payload" JSONB NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'proposed',
  "confirmationId" TEXT,
  "missionId" UUID,
  "jobId" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmedAt" TIMESTAMPTZ(3),
  CONSTRAINT "ChatProposal_groupId_version_key" UNIQUE ("groupId", "version"),
  CONSTRAINT "ChatProposal_conversationId_confirmationId_key" UNIQUE ("conversationId", "confirmationId"),
  CONSTRAINT "ChatProposal_conversation_fkey" FOREIGN KEY ("workspaceId", "projectId", "conversationId", "userId") REFERENCES "ChatConversation"("workspaceId", "projectId", "id", "userId") ON DELETE CASCADE,
  CONSTRAINT "ChatProposal_status_check" CHECK ("status" IN ('proposed','confirmed','blocked'))
);
CREATE INDEX "ChatProposal_workspaceId_projectId_userId_conversationId_idx" ON "ChatProposal"("workspaceId", "projectId", "userId", "conversationId");

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['ChatConversation','ChatMessage','ChatRun','ChatProposal'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY chat_owner_scope ON %I USING ("workspaceId"=nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND "projectId"=nullif(current_setting(''app.project_id'',true),'''')::uuid AND "userId"=nullif(current_setting(''app.user_id'',true),'''')) WITH CHECK ("workspaceId"=nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND "projectId"=nullif(current_setting(''app.project_id'',true),'''')::uuid AND "userId"=nullif(current_setting(''app.user_id'',true),''''))', table_name);
  END LOOP;
END $$;
