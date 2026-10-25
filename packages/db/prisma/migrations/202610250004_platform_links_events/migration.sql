-- Object links and domain events (ADR 0016). Both are platform tables in the
-- project scope with forced row-level security. Links reference objects of
-- any module by type and id, so they carry no foreign keys to those objects;
-- the owning modules resolve them. Events are append-only and content-free.

CREATE TABLE "ObjectLink" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" UUID NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" UUID NOT NULL,
  "relation" TEXT NOT NULL,
  "createdByKind" TEXT NOT NULL,
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "removedAt" TIMESTAMPTZ(3),
  "removedById" TEXT,
  CONSTRAINT "ObjectLink_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ObjectLink_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ObjectLink_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "ObjectLink_sourceType_check" CHECK ("sourceType" ~ '^[a-z][a-z0-9_]{1,30}\.[a-z][a-z0-9_]{1,40}$'),
  CONSTRAINT "ObjectLink_targetType_check" CHECK ("targetType" ~ '^[a-z][a-z0-9_]{1,30}\.[a-z][a-z0-9_]{1,40}$'),
  CONSTRAINT "ObjectLink_relation_check" CHECK ("relation" IN ('relates_to','implements','reported_in','duplicates','delegated_to','documents')),
  CONSTRAINT "ObjectLink_createdByKind_check" CHECK ("createdByKind" IN ('user','agent','system','mcp','integration')),
  CONSTRAINT "ObjectLink_not_self" CHECK (NOT ("sourceType" = "targetType" AND "sourceId" = "targetId"))
);
CREATE UNIQUE INDEX "ObjectLink_active_key" ON "ObjectLink"("projectId", "sourceType", "sourceId", "relation", "targetType", "targetId") WHERE "removedAt" IS NULL;
CREATE INDEX "ObjectLink_projectId_sourceType_sourceId_idx" ON "ObjectLink"("projectId", "sourceType", "sourceId");
CREATE INDEX "ObjectLink_projectId_targetType_targetId_idx" ON "ObjectLink"("projectId", "targetType", "targetId");

CREATE TABLE "DomainEvent" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "subjectType" TEXT NOT NULL,
  "subjectId" UUID NOT NULL,
  "actorKind" TEXT NOT NULL,
  "actorId" TEXT,
  "origin" TEXT NOT NULL,
  "causationId" UUID,
  "correlationId" UUID NOT NULL,
  "depth" INTEGER NOT NULL DEFAULT 0,
  "data" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DomainEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DomainEvent_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DomainEvent_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "DomainEvent_type_check" CHECK ("type" ~ '^[a-z][a-z0-9_]{1,30}(\.[a-z][a-z0-9_]{1,40}){2,3}$'),
  CONSTRAINT "DomainEvent_actorKind_check" CHECK ("actorKind" IN ('user','agent','system','mcp','integration')),
  CONSTRAINT "DomainEvent_depth_check" CHECK ("depth" >= 0 AND "depth" <= 5),
  CONSTRAINT "DomainEvent_data_size" CHECK (octet_length("data"::text) <= 4096)
);
CREATE INDEX "DomainEvent_projectId_type_createdAt_idx" ON "DomainEvent"("projectId", "type", "createdAt");
CREATE INDEX "DomainEvent_projectId_subjectType_subjectId_createdAt_idx" ON "DomainEvent"("projectId", "subjectType", "subjectId", "createdAt");
CREATE INDEX "DomainEvent_projectId_correlationId_idx" ON "DomainEvent"("projectId", "correlationId");

ALTER TABLE "ObjectLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ObjectLink" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "ObjectLink"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);

ALTER TABLE "DomainEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DomainEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "DomainEvent"
  USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
  WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
