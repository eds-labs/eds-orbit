-- Member notifications (Orbit Platform, WP4.7): in-app notices per member
-- and each member's choice per kind (in-app, e-mail). Private to the member
-- like the chat tables: the policy also needs app.user_id. Additive.
CREATE TABLE "Notification" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "moduleId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL DEFAULT '',
  "link" TEXT,
  "readAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Notification_kind_check" CHECK ("kind" ~ '^[a-z][a-z0-9_]{1,60}$'),
  CONSTRAINT "Notification_link_check" CHECK ("link" IS NULL OR "link" ~ '^/[^/]'),
  CONSTRAINT "Notification_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Notification_user_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Notification_workspaceId_projectId_userId_createdAt_idx" ON "Notification"("workspaceId", "projectId", "userId", "createdAt");

CREATE TABLE "NotificationPreference" (
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "inApp" BOOLEAN NOT NULL,
  "email" BOOLEAN NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("projectId", "userId", "kind"),
  CONSTRAINT "NotificationPreference_project_fkey" FOREIGN KEY ("workspaceId", "projectId") REFERENCES "Project"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "NotificationPreference_user_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['Notification','NotificationPreference'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY member_scope ON %I USING ("workspaceId"=nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND "projectId"=nullif(current_setting(''app.project_id'',true),'''')::uuid AND "userId"=nullif(current_setting(''app.user_id'',true),'''')) WITH CHECK ("workspaceId"=nullif(current_setting(''app.workspace_id'',true),'''')::uuid AND "projectId"=nullif(current_setting(''app.project_id'',true),'''')::uuid AND "userId"=nullif(current_setting(''app.user_id'',true),''''))', table_name);
  END LOOP;
END $$;
