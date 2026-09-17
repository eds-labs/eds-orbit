-- Forward-only profile generation support. Existing baseline vectors are preserved.
CREATE TABLE "KnowledgeIndex" (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  generation INTEGER NOT NULL,
  profile TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  metric TEXT NOT NULL DEFAULT 'cosine',
  "transformVersion" TEXT NOT NULL DEFAULT 'structure-v1',
  state TEXT NOT NULL DEFAULT 'building',
  manifest JSONB NOT NULL,
  "manifestHash" TEXT NOT NULL,
  evaluation JSONB,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedAt" TIMESTAMPTZ(3),
  CONSTRAINT "KnowledgeIndex_pkey" PRIMARY KEY (id),
  CONSTRAINT "KnowledgeIndex_project_fk" FOREIGN KEY ("workspaceId","projectId") REFERENCES "Project"("workspaceId",id) ON DELETE CASCADE,
  CONSTRAINT "KnowledgeIndex_config_check" CHECK (generation>0 AND metric='cosine' AND "transformVersion"='structure-v1' AND ((model='text-embedding-3-small' AND dimensions=1536 AND profile='openai:text-embedding-3-small:1536:chunk-v1') OR (model='text-embedding-3-large' AND dimensions IN (1536,3072) AND profile='openai:text-embedding-3-large:'||dimensions||':chunk-v1'))),
  CONSTRAINT "KnowledgeIndex_state_check" CHECK (state IN ('building','evaluated','active','retired','failed'))
);
CREATE UNIQUE INDEX "KnowledgeIndex_workspaceId_projectId_generation_key" ON "KnowledgeIndex"("workspaceId","projectId",generation);
CREATE UNIQUE INDEX "KnowledgeIndex_workspaceId_projectId_profile_generation_key" ON "KnowledgeIndex"("workspaceId","projectId",profile,generation);
CREATE INDEX "KnowledgeIndex_workspaceId_projectId_state_idx" ON "KnowledgeIndex"("workspaceId","projectId",state);
CREATE UNIQUE INDEX "KnowledgeIndex_one_active" ON "KnowledgeIndex"("workspaceId","projectId") WHERE state='active';
-- Migrations run under the trusted migrator; preserve the initial default profile.
INSERT INTO "KnowledgeIndex" ("workspaceId","projectId",generation,profile,model,dimensions,state,manifest,"manifestHash","activatedAt")
SELECT "workspaceId",id,1,'openai:text-embedding-3-small:1536:chunk-v1','text-embedding-3-small',1536,'active','[]'::jsonb,'legacy-baseline',CURRENT_TIMESTAMP FROM "Project";
ALTER TABLE "ChunkEmbedding" DROP CONSTRAINT "Embedding_profile_dimensions";
ALTER TABLE "ChunkEmbedding" ALTER COLUMN vector TYPE vector USING vector::vector;
ALTER TABLE "ChunkEmbedding" ADD CONSTRAINT "Embedding_profile_dimensions" CHECK ("indexGeneration">0 AND vector_dims(vector)=dimensions AND ((model='text-embedding-3-small' AND dimensions=1536 AND profile='openai:text-embedding-3-small:1536:chunk-v1') OR (model='text-embedding-3-large' AND dimensions IN (1536,3072) AND profile='openai:text-embedding-3-large:'||dimensions||':chunk-v1')));
ALTER TABLE "ChunkEmbedding" ADD CONSTRAINT "ChunkEmbedding_index_generation_fk" FOREIGN KEY ("workspaceId","projectId",profile,"indexGeneration") REFERENCES "KnowledgeIndex"("workspaceId","projectId",profile,generation) ON DELETE CASCADE;
CREATE FUNCTION orbit_immutable_index_config() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."workspaceId",NEW."projectId",NEW.generation,NEW.profile,NEW.model,NEW.dimensions,NEW.metric,NEW."transformVersion",NEW.manifest,NEW."manifestHash") IS DISTINCT FROM ROW(OLD."workspaceId",OLD."projectId",OLD.generation,OLD.profile,OLD.model,OLD.dimensions,OLD.metric,OLD."transformVersion",OLD.manifest,OLD."manifestHash") THEN
    RAISE EXCEPTION 'Knowledge index configuration is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER index_config_immutable BEFORE UPDATE ON "KnowledgeIndex" FOR EACH ROW EXECUTE FUNCTION orbit_immutable_index_config();
ALTER TABLE "KnowledgeIndex" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "KnowledgeIndex" FORCE ROW LEVEL SECURITY;
CREATE POLICY project_scope ON "KnowledgeIndex" USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid) WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid);
