-- Issue center (ADR 0018, plan §3): issues, their redacted source reports,
-- history, attachments, duplicate candidates, external references and
-- delivery records. Every table is project-scoped with forced row-level
-- security; references between module rows (and to "File") are composite
-- ("projectId", id) keys, because foreign key checks bypass RLS. Texts are
-- stored redacted (decision I-5); raw payloads are never stored. Duplicate
-- search is full-text only: pg_trgm is not installed (plan §3.6, R-P3-11).

-- The last issue number per project (ISS-<n>); numbers are never reused.
CREATE TABLE "IssueCounter" (
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "lastNumber" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "IssueCounter_pkey" PRIMARY KEY ("projectId"),
  CONSTRAINT "IssueCounter_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "IssueCounter_lastNumber_check" CHECK ("lastNumber" >= 0)
);

CREATE TABLE "Issue" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "number" INTEGER NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'bug',
  "title" TEXT NOT NULL,
  "summary" TEXT,
  "status" TEXT NOT NULL DEFAULT 'new',
  "severity" TEXT,
  "priority" TEXT,
  "category" TEXT,
  "components" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "assigneeUserId" TEXT,
  "fingerprint" TEXT,
  "environment" TEXT,
  "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reportCount" INTEGER NOT NULL DEFAULT 0,
  "ticketCount" INTEGER NOT NULL DEFAULT 0,
  "mergedIntoIssueId" UUID,
  "acceptanceCriteria" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "shareReviewedAt" TIMESTAMPTZ(3),
  "shareReviewedBy" TEXT,
  "searchVector" tsvector,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMPTZ(3),
  CONSTRAINT "Issue_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Issue_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Issue_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "Issue_projectId_number_key" UNIQUE ("projectId", "number"),
  -- A duplicate keeps no reports (they moved to the target); it goes with
  -- its target.
  CONSTRAINT "Issue_mergedInto_fkey" FOREIGN KEY ("projectId", "mergedIntoIssueId") REFERENCES "Issue"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "Issue_merged_check" CHECK (("status" = 'duplicate') = ("mergedIntoIssueId" IS NOT NULL) AND ("mergedIntoIssueId" IS NULL OR "mergedIntoIssueId" <> "id")),
  CONSTRAINT "Issue_number_check" CHECK ("number" > 0),
  CONSTRAINT "Issue_type_check" CHECK ("type" IN ('bug','feature_request','improvement','technical_problem')),
  CONSTRAINT "Issue_title_check" CHECK (char_length("title") BETWEEN 1 AND 200),
  CONSTRAINT "Issue_summary_check" CHECK ("summary" IS NULL OR char_length("summary") <= 10000),
  CONSTRAINT "Issue_status_check" CHECK ("status" IN ('new','triage','needs_info','confirmed','duplicate','wont_fix','planned','in_progress','fix_ready','released','verified','closed')),
  CONSTRAINT "Issue_severity_check" CHECK ("severity" IS NULL OR "severity" IN ('s1_critical','s2_major','s3_minor','s4_trivial')),
  CONSTRAINT "Issue_priority_check" CHECK ("priority" IS NULL OR "priority" IN ('urgent','high','medium','low')),
  CONSTRAINT "Issue_components_check" CHECK (cardinality("components") <= 20),
  CONSTRAINT "Issue_acceptance_check" CHECK (cardinality("acceptanceCriteria") <= 10),
  CONSTRAINT "Issue_fingerprint_check" CHECK ("fingerprint" IS NULL OR char_length("fingerprint") BETWEEN 1 AND 200),
  CONSTRAINT "Issue_environment_check" CHECK ("environment" IS NULL OR "environment" ~ '^[A-Za-z0-9._-]{1,40}$'),
  CONSTRAINT "Issue_counts_check" CHECK ("reportCount" >= 0 AND "ticketCount" >= 0),
  CONSTRAINT "Issue_seen_check" CHECK ("lastSeenAt" >= "firstSeenAt"),
  CONSTRAINT "Issue_share_check" CHECK (("shareReviewedAt" IS NULL) = ("shareReviewedBy" IS NULL))
);
CREATE INDEX "Issue_projectId_status_severity_idx" ON "Issue"("projectId", "status", "severity");
CREATE INDEX "Issue_projectId_assigneeUserId_status_idx" ON "Issue"("projectId", "assigneeUserId", "status");
CREATE INDEX "Issue_projectId_lastSeenAt_idx" ON "Issue"("projectId", "lastSeenAt");
CREATE INDEX "Issue_projectId_fingerprint_idx" ON "Issue"("projectId", "fingerprint") WHERE "fingerprint" IS NOT NULL;
CREATE INDEX "Issue_projectId_mergedIntoIssueId_idx" ON "Issue"("projectId", "mergedIntoIssueId");
CREATE INDEX "Issue_searchVector_idx" ON "Issue" USING GIN ("searchVector");
CREATE INDEX "Issue_components_idx" ON "Issue" USING GIN ("components");

-- Full-text search over titles (A), summaries (B) and component keys (C)
-- in any language: the 'simple' configuration, as for tasks and messages.
CREATE FUNCTION issue_search_vector() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('simple'::regconfig, coalesce(NEW."title", '')), 'A') ||
    setweight(to_tsvector('simple'::regconfig, coalesce(NEW."summary", '')), 'B') ||
    setweight(to_tsvector('simple'::regconfig, array_to_string(NEW."components", ' ')), 'C');
  RETURN NEW;
END $$;
CREATE TRIGGER issue_search_vector BEFORE INSERT OR UPDATE OF "title", "summary", "components" ON "Issue"
  FOR EACH ROW EXECUTE FUNCTION issue_search_vector();

-- One inbound signal. Reports move to the surviving issue on a merge and
-- are deleted only with their issue (no DELETE grant).
CREATE TABLE "IssueReport" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "issueId" UUID NOT NULL,
  "sourceKind" TEXT NOT NULL,
  "sourceConnectionId" UUID,
  "externalSystem" TEXT,
  "externalId" TEXT,
  "externalUrl" TEXT,
  "fingerprint" TEXT,
  "title" TEXT NOT NULL,
  "symptoms" TEXT NOT NULL,
  "diagnostics" JSONB NOT NULL DEFAULT '{}',
  "redaction" JSONB NOT NULL DEFAULT '{}',
  "severityHint" TEXT,
  "typeHint" TEXT,
  "componentHints" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "environment" TEXT,
  "release" TEXT,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reportedByKind" TEXT NOT NULL,
  "reportedById" TEXT,
  "erasedAt" TIMESTAMPTZ(3),
  CONSTRAINT "IssueReport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IssueReport_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "IssueReport_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "IssueReport_issue_fkey" FOREIGN KEY ("projectId", "issueId") REFERENCES "Issue"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "IssueReport_sourceKind_check" CHECK ("sourceKind" IN ('support','manual','webhook','n8n','sentry','github','monitoring')),
  CONSTRAINT "IssueReport_external_check" CHECK (("externalSystem" IS NULL) = ("externalId" IS NULL) AND ("externalSystem" IS NULL OR "externalSystem" ~ '^[a-z][a-z0-9_.-]{1,40}$') AND ("externalId" IS NULL OR char_length("externalId") BETWEEN 1 AND 200)),
  CONSTRAINT "IssueReport_externalUrl_check" CHECK ("externalUrl" IS NULL OR ("externalUrl" ~ '^https://' AND char_length("externalUrl") <= 500)),
  CONSTRAINT "IssueReport_fingerprint_check" CHECK ("fingerprint" IS NULL OR char_length("fingerprint") BETWEEN 1 AND 200),
  CONSTRAINT "IssueReport_title_check" CHECK (char_length("title") BETWEEN 1 AND 200),
  CONSTRAINT "IssueReport_symptoms_check" CHECK (char_length("symptoms") <= 4000),
  CONSTRAINT "IssueReport_diagnostics_check" CHECK (jsonb_typeof("diagnostics") = 'object' AND pg_column_size("diagnostics") <= 4096),
  CONSTRAINT "IssueReport_redaction_check" CHECK (jsonb_typeof("redaction") = 'object' AND pg_column_size("redaction") <= 1024),
  CONSTRAINT "IssueReport_severityHint_check" CHECK ("severityHint" IS NULL OR "severityHint" IN ('s1_critical','s2_major','s3_minor','s4_trivial')),
  CONSTRAINT "IssueReport_typeHint_check" CHECK ("typeHint" IS NULL OR "typeHint" IN ('bug','feature_request','improvement','technical_problem')),
  CONSTRAINT "IssueReport_componentHints_check" CHECK (cardinality("componentHints") <= 20),
  CONSTRAINT "IssueReport_environment_check" CHECK ("environment" IS NULL OR "environment" ~ '^[A-Za-z0-9._-]{1,40}$'),
  CONSTRAINT "IssueReport_release_check" CHECK ("release" IS NULL OR "release" ~ '^[A-Za-z0-9._+-]{1,80}$'),
  CONSTRAINT "IssueReport_reportedByKind_check" CHECK ("reportedByKind" IN ('user','integration','agent'))
);
CREATE INDEX "IssueReport_projectId_issueId_receivedAt_idx" ON "IssueReport"("projectId", "issueId", "receivedAt");
CREATE INDEX "IssueReport_projectId_receivedAt_idx" ON "IssueReport"("projectId", "receivedAt");
-- A re-delivered external report is the same report (idempotent intake).
CREATE UNIQUE INDEX "IssueReport_external_key" ON "IssueReport"("projectId", "sourceKind", "externalSystem", "externalId") WHERE "externalId" IS NOT NULL;

-- History: one row per change, ids, keys and field names only.
CREATE TABLE "IssueEvent" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "issueId" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "actorKind" TEXT NOT NULL,
  "actorId" TEXT,
  "before" JSONB NOT NULL DEFAULT '{}',
  "after" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IssueEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IssueEvent_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "IssueEvent_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "IssueEvent_issue_fkey" FOREIGN KEY ("projectId", "issueId") REFERENCES "Issue"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "IssueEvent_type_check" CHECK ("type" IN ('created','status','severity','priority','type','fields','components','assignee','report_attached','report_moved','merged','duplicate_candidate','link_added','link_removed','delivery','ai_triage','share_review','github','erased')),
  CONSTRAINT "IssueEvent_actorKind_check" CHECK ("actorKind" IN ('user','agent','system','mcp','integration')),
  CONSTRAINT "IssueEvent_payload_check" CHECK (pg_column_size("before") <= 4096 AND pg_column_size("after") <= 4096)
);
CREATE INDEX "IssueEvent_projectId_issueId_createdAt_idx" ON "IssueEvent"("projectId", "issueId", "createdAt");
CREATE INDEX "IssueEvent_projectId_type_createdAt_idx" ON "IssueEvent"("projectId", "type", "createdAt");

CREATE TABLE "IssueAttachment" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "issueId" UUID NOT NULL,
  "fileId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "mime" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "addedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IssueAttachment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IssueAttachment_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "IssueAttachment_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "IssueAttachment_issue_fkey" FOREIGN KEY ("projectId", "issueId") REFERENCES "Issue"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "IssueAttachment_file_fkey" FOREIGN KEY ("projectId", "fileId") REFERENCES "File"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "IssueAttachment_issue_file_key" UNIQUE ("projectId", "issueId", "fileId"),
  CONSTRAINT "IssueAttachment_size_check" CHECK ("size" >= 0)
);
CREATE INDEX "IssueAttachment_projectId_issueId_idx" ON "IssueAttachment"("projectId", "issueId");

-- A possible duplicate: "issueId" (the newer side) may be the same problem
-- as "candidateIssueId". Rejected pairs stay so they are not proposed again.
CREATE TABLE "IssueDuplicateCandidate" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "issueId" UUID NOT NULL,
  "candidateIssueId" UUID NOT NULL,
  "method" TEXT NOT NULL,
  "score" DECIMAL(5,4) NOT NULL,
  "reasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" TEXT NOT NULL DEFAULT 'pending',
  "decidedBy" TEXT,
  "decidedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IssueDuplicateCandidate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IssueDuplicateCandidate_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "IssueDuplicateCandidate_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "IssueDuplicateCandidate_pair_key" UNIQUE ("projectId", "issueId", "candidateIssueId"),
  CONSTRAINT "IssueDuplicateCandidate_issue_fkey" FOREIGN KEY ("projectId", "issueId") REFERENCES "Issue"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "IssueDuplicateCandidate_candidate_fkey" FOREIGN KEY ("projectId", "candidateIssueId") REFERENCES "Issue"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "IssueDuplicateCandidate_not_self" CHECK ("issueId" <> "candidateIssueId"),
  CONSTRAINT "IssueDuplicateCandidate_method_check" CHECK ("method" IN ('fingerprint','external_ref','lexical','vector','ai')),
  CONSTRAINT "IssueDuplicateCandidate_score_check" CHECK ("score" BETWEEN 0 AND 1),
  CONSTRAINT "IssueDuplicateCandidate_reasons_check" CHECK (cardinality("reasons") <= 10),
  CONSTRAINT "IssueDuplicateCandidate_status_check" CHECK ("status" IN ('pending','confirmed','rejected')),
  CONSTRAINT "IssueDuplicateCandidate_decided_check" CHECK (("status" = 'pending') = ("decidedAt" IS NULL))
);
CREATE INDEX "IssueDuplicateCandidate_projectId_status_idx" ON "IssueDuplicateCandidate"("projectId", "status");
CREATE INDEX "IssueDuplicateCandidate_projectId_candidateIssueId_idx" ON "IssueDuplicateCandidate"("projectId", "candidateIssueId");

-- The issue's counterpart in an external tracker (GitHub, Sentry, …).
CREATE TABLE "IssueExternalRef" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "issueId" UUID NOT NULL,
  "system" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "url" TEXT,
  "state" TEXT,
  "syncedAt" TIMESTAMPTZ(3),
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IssueExternalRef_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IssueExternalRef_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "IssueExternalRef_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "IssueExternalRef_external_key" UNIQUE ("projectId", "system", "externalId"),
  CONSTRAINT "IssueExternalRef_issue_fkey" FOREIGN KEY ("projectId", "issueId") REFERENCES "Issue"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "IssueExternalRef_system_check" CHECK ("system" ~ '^[a-z][a-z0-9_.-]{1,40}$'),
  CONSTRAINT "IssueExternalRef_externalId_check" CHECK (char_length("externalId") BETWEEN 1 AND 200),
  CONSTRAINT "IssueExternalRef_url_check" CHECK ("url" IS NULL OR ("url" ~ '^https://' AND char_length("url") <= 500)),
  CONSTRAINT "IssueExternalRef_state_check" CHECK ("state" IS NULL OR "state" IN ('open','closed'))
);
CREATE INDEX "IssueExternalRef_projectId_issueId_idx" ON "IssueExternalRef"("projectId", "issueId");

-- What happened to the fix: merged, deployed per environment, verified.
-- Append-only (no UPDATE or DELETE grant); goes with its issue.
CREATE TABLE "IssueDelivery" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "issueId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "repository" TEXT,
  "prNumber" INTEGER,
  "commitSha" TEXT,
  "environment" TEXT,
  "source" TEXT NOT NULL,
  "status" TEXT,
  "observedAt" TIMESTAMPTZ(3) NOT NULL,
  "recordedBy" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IssueDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IssueDelivery_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "IssueDelivery_projectId_id_key" UNIQUE ("projectId", "id"),
  CONSTRAINT "IssueDelivery_issue_fkey" FOREIGN KEY ("projectId", "issueId") REFERENCES "Issue"("projectId", "id") ON DELETE CASCADE,
  CONSTRAINT "IssueDelivery_kind_check" CHECK ("kind" IN ('pr_opened','pr_merged','checks','deployed','verified')),
  CONSTRAINT "IssueDelivery_source_check" CHECK ("source" IN ('github','automation','manual')),
  CONSTRAINT "IssueDelivery_repository_check" CHECK ("repository" IS NULL OR "repository" ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
  CONSTRAINT "IssueDelivery_prNumber_check" CHECK ("prNumber" IS NULL OR "prNumber" > 0),
  CONSTRAINT "IssueDelivery_commitSha_check" CHECK ("commitSha" IS NULL OR "commitSha" ~ '^[0-9a-f]{7,40}$'),
  CONSTRAINT "IssueDelivery_environment_check" CHECK ("environment" IS NULL OR "environment" ~ '^[A-Za-z0-9._-]{1,40}$'),
  CONSTRAINT "IssueDelivery_deployed_check" CHECK ("kind" <> 'deployed' OR "environment" IS NOT NULL),
  CONSTRAINT "IssueDelivery_status_check" CHECK ("status" IS NULL OR "status" IN ('success','failure'))
);
CREATE INDEX "IssueDelivery_projectId_issueId_observedAt_idx" ON "IssueDelivery"("projectId", "issueId", "observedAt");

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['IssueCounter','Issue','IssueReport','IssueEvent','IssueAttachment','IssueDuplicateCandidate','IssueExternalRef','IssueDelivery'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY project_scope ON %I
      USING ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)
      WITH CHECK ("workspaceId"=nullif(current_setting('app.workspace_id',true),'')::uuid AND "projectId"=nullif(current_setting('app.project_id',true),'')::uuid)$p$, t);
  END LOOP;
END $$;
