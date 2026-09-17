-- EDS Orbit initial schema, generated from Prisma 7.10.0.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ(3),
    "refreshTokenExpiresAt" TIMESTAMPTZ(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "workspaceId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("workspaceId","userId")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "language" TEXT NOT NULL DEFAULT 'en',
    "mode" TEXT NOT NULL DEFAULT 'observe',
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectMember" (
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("projectId","userId")
);

-- CreateTable
CREATE TABLE "Entity" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityVersion" (
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "entityId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntityVersion_pkey" PRIMARY KEY ("entityId","version")
);

-- CreateTable
CREATE TABLE "Outbox" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetReservation" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "amountMicros" BIGINT NOT NULL,
    "category" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledMicros" BIGINT,

    CONSTRAINT "BudgetReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeDocument" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "activeVersionId" UUID,
    "canonicalUrl" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentVersion" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "extractorVersion" TEXT NOT NULL,
    "sourceGeneration" INTEGER NOT NULL,
    "sourceUpdatedAt" TIMESTAMPTZ(3),
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validFrom" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMPTZ(3),
    "state" TEXT NOT NULL DEFAULT 'prepared',

    CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "documentVersionId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "heading" TEXT NOT NULL,
    "anchor" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "chunkHash" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "tokenEstimate" INTEGER NOT NULL,
    "searchVector" tsvector,
    "identifierVector" tsvector,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChunkEmbedding" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "chunkId" UUID NOT NULL,
    "profile" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "indexGeneration" INTEGER NOT NULL DEFAULT 1,
    "vector" vector(1536) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChunkEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "account_providerId_accountId_key" ON "account"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE INDEX "WorkspaceMember_userId_idx" ON "WorkspaceMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_workspaceId_id_key" ON "Project"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "ProjectMember_workspaceId_userId_idx" ON "ProjectMember"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "Entity_workspaceId_projectId_kind_idx" ON "Entity"("workspaceId", "projectId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Entity_projectId_id_key" ON "Entity"("projectId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Entity_workspaceId_projectId_id_key" ON "Entity"("workspaceId", "projectId", "id");

-- CreateIndex
CREATE INDEX "EntityVersion_workspaceId_projectId_idx" ON "EntityVersion"("workspaceId", "projectId");

-- CreateIndex
CREATE INDEX "Outbox_workspaceId_projectId_dispatchedAt_availableAt_idx" ON "Outbox"("workspaceId", "projectId", "dispatchedAt", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetReservation_key_key" ON "BudgetReservation"("key");

-- CreateIndex
CREATE INDEX "BudgetReservation_workspaceId_projectId_createdAt_idx" ON "BudgetReservation"("workspaceId", "projectId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_workspaceId_projectId_createdAt_idx" ON "AuditEvent"("workspaceId", "projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeDocument_workspaceId_projectId_sourceId_externalId_key" ON "KnowledgeDocument"("workspaceId", "projectId", "sourceId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeDocument_workspaceId_projectId_id_key" ON "KnowledgeDocument"("workspaceId", "projectId", "id");

-- CreateIndex
CREATE INDEX "DocumentVersion_workspaceId_projectId_contentHash_idx" ON "DocumentVersion"("workspaceId", "projectId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentVersion_documentId_version_key" ON "DocumentVersion"("documentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentVersion_workspaceId_projectId_id_key" ON "DocumentVersion"("workspaceId", "projectId", "id");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_workspaceId_projectId_idx" ON "KnowledgeChunk"("workspaceId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeChunk_documentVersionId_position_key" ON "KnowledgeChunk"("documentVersionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeChunk_workspaceId_projectId_id_key" ON "KnowledgeChunk"("workspaceId", "projectId", "id");

-- CreateIndex
CREATE INDEX "ChunkEmbedding_workspaceId_projectId_profile_indexGeneratio_idx" ON "ChunkEmbedding"("workspaceId", "projectId", "profile", "indexGeneration");

-- CreateIndex
CREATE UNIQUE INDEX "ChunkEmbedding_chunkId_profile_indexGeneration_key" ON "ChunkEmbedding"("chunkId", "profile", "indexGeneration");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_workspaceId_projectId_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_workspaceId_projectId_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityVersion" ADD CONSTRAINT "EntityVersion_workspaceId_projectId_entityId_fkey" FOREIGN KEY ("workspaceId", "projectId", "entityId") REFERENCES "Entity"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Outbox" ADD CONSTRAINT "Outbox_workspaceId_projectId_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetReservation" ADD CONSTRAINT "BudgetReservation_workspaceId_projectId_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_workspaceId_projectId_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_workspaceId_projectId_sourceId_fkey" FOREIGN KEY ("workspaceId", "projectId", "sourceId") REFERENCES "Entity"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_workspaceId_projectId_documentId_fkey" FOREIGN KEY ("workspaceId", "projectId", "documentId") REFERENCES "KnowledgeDocument"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_workspaceId_projectId_documentVersionId_fkey" FOREIGN KEY ("workspaceId", "projectId", "documentVersionId") REFERENCES "DocumentVersion"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChunkEmbedding" ADD CONSTRAINT "ChunkEmbedding_workspaceId_projectId_chunkId_fkey" FOREIGN KEY ("workspaceId", "projectId", "chunkId") REFERENCES "KnowledgeChunk"("workspaceId", "projectId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Applied after generated table DDL. Roles are provisioned outside migrations.
-- Authentication/control-plane grants are separate from tenant business data.
ALTER TABLE "Project" ADD CONSTRAINT "Project_mode_check" CHECK (mode IN ('observe','assisted','autopilot'));
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_role_check" CHECK (role IN ('owner','editor','viewer'));
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_role_check" CHECK (role IN ('owner','editor','viewer'));
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_workspace_membership_fk" FOREIGN KEY ("workspaceId","userId") REFERENCES "WorkspaceMember"("workspaceId","userId") ON DELETE CASCADE;
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_version_positive" CHECK (version>0);
ALTER TABLE "BudgetReservation" ADD CONSTRAINT "Budget_nonnegative" CHECK ("amountMicros">=0 AND ("settledMicros" IS NULL OR "settledMicros">=0));
ALTER TABLE "ChunkEmbedding" ADD CONSTRAINT "Embedding_profile_dimensions" CHECK (dimensions=1536 AND "indexGeneration">0 AND profile='openai:text-embedding-3-small:1536:chunk-v1' AND model='text-embedding-3-small');
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_valid_interval" CHECK ("validUntil" IS NULL OR "validUntil">"validFrom");
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_document_identity" UNIQUE ("workspaceId","projectId","documentId",id);
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "Document_active_version_fk" FOREIGN KEY ("workspaceId","projectId",id,"activeVersionId") REFERENCES "DocumentVersion"("workspaceId","projectId","documentId",id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "Outbox" ADD CONSTRAINT "Outbox_entity_scope_fk" FOREIGN KEY ("workspaceId","projectId","entityId") REFERENCES "Entity"("workspaceId","projectId",id) ON DELETE CASCADE;
CREATE FUNCTION orbit_chunk_search() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" := to_tsvector(CASE WHEN NEW.language='de' THEN 'german'::regconfig ELSE 'english'::regconfig END,NEW.heading || ' ' || NEW.text);
  NEW."identifierVector" := to_tsvector('simple',NEW.heading || ' ' || NEW.text);
  RETURN NEW;
END;
$$;
CREATE TRIGGER chunk_search BEFORE INSERT OR UPDATE OF text,heading,language ON "KnowledgeChunk" FOR EACH ROW EXECUTE FUNCTION orbit_chunk_search();
CREATE INDEX "KnowledgeChunk_fts" ON "KnowledgeChunk" USING GIN ("searchVector");
CREATE INDEX "KnowledgeChunk_identifiers" ON "KnowledgeChunk" USING GIN ("identifierVector");
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['Project','ProjectMember','Entity','EntityVersion','Outbox','BudgetReservation','KnowledgeDocument','DocumentVersion','KnowledgeChunk','ChunkEmbedding'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    IF table_name='Project' THEN
      EXECUTE format('CREATE POLICY project_scope ON %I USING ("workspaceId"=nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND id=nullif(current_setting(''app.project_id'',true),'''')::uuid) WITH CHECK ("workspaceId"=nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND id=nullif(current_setting(''app.project_id'',true),'''')::uuid)',table_name);
    ELSE
      EXECUTE format('CREATE POLICY project_scope ON %I USING ("workspaceId"=nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND "projectId"=nullif(current_setting(''app.project_id'',true),'''')::uuid) WITH CHECK ("workspaceId"=nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND "projectId"=nullif(current_setting(''app.project_id'',true),'''')::uuid)',table_name);
    END IF;
  END LOOP;
END $$;
ALTER TABLE "AuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON "AuditEvent" FOR SELECT USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
CREATE POLICY audit_append ON "AuditEvent" FOR INSERT WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
ALTER TABLE "Workspace" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Workspace" FORCE ROW LEVEL SECURITY;
ALTER TABLE "WorkspaceMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkspaceMember" FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_control ON "Workspace" TO orbit_auth USING(true) WITH CHECK(true);
CREATE POLICY auth_control ON "WorkspaceMember" TO orbit_auth USING(true) WITH CHECK(true);
CREATE POLICY auth_control ON "Project" TO orbit_auth USING(true) WITH CHECK(true);
CREATE POLICY auth_control ON "ProjectMember" TO orbit_auth USING(true) WITH CHECK(true);
-- A direct unscoped business connection has no visible rows. Session pooling uses SET LOCAL.
