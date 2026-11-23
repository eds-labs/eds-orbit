CREATE TABLE "ProjectHomeLayout" (
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "widgets" JSONB,
  CONSTRAINT "ProjectHomeLayout_pkey" PRIMARY KEY ("projectId", "userId"),
  CONSTRAINT "ProjectHomeLayout_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "ProjectHomeLayout_project_fkey" FOREIGN KEY ("workspaceId", "projectId")
    REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectHomeLayout_user_fkey" FOREIGN KEY ("userId")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ProjectHomeLayout_userId_idx" ON "ProjectHomeLayout"("userId");

ALTER TABLE "ProjectHomeLayout" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProjectHomeLayout" FORCE ROW LEVEL SECURITY;

CREATE POLICY member_scope ON "ProjectHomeLayout" USING (
  "workspaceId" = nullif(current_setting('app.workspace_id', true), '')::uuid
  AND "projectId" = nullif(current_setting('app.project_id', true), '')::uuid
  AND "userId" = nullif(current_setting('app.user_id', true), '')
) WITH CHECK (
  "workspaceId" = nullif(current_setting('app.workspace_id', true), '')::uuid
  AND "projectId" = nullif(current_setting('app.project_id', true), '')::uuid
  AND "userId" = nullif(current_setting('app.user_id', true), '')
);
