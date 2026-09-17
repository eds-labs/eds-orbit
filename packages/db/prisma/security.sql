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
