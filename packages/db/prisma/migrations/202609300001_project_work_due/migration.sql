-- Durable per-project work marker. The worker selects only projects whose marker is due
-- instead of opening a scoped transaction for every project on every tick. The marker holds
-- no business data; orbit_auth can already read every "Project" row.
ALTER TABLE "Project" ADD COLUMN "workDueAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "Project_workDueAt_idx" ON "Project"("workDueAt");

-- Trigger functions run with the invoking role, so project RLS still applies to every marker update.
CREATE FUNCTION orbit_outbox_mark_due() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."dispatchedAt" IS NULL THEN
    UPDATE "Project" SET "workDueAt" = NEW."availableAt"
      WHERE id = NEW."projectId" AND "workspaceId" = NEW."workspaceId" AND "workDueAt" > NEW."availableAt";
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER outbox_mark_due AFTER INSERT OR UPDATE OF "availableAt", "dispatchedAt" ON "Outbox"
  FOR EACH ROW EXECUTE FUNCTION orbit_outbox_mark_due();

-- Any business state change may make a sweep transition due; the marker only moves earlier.
CREATE FUNCTION orbit_entity_mark_due() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Project" SET "workDueAt" = now()
    WHERE id = NEW."projectId" AND "workspaceId" = NEW."workspaceId" AND "workDueAt" > now();
  RETURN NULL;
END $$;
CREATE TRIGGER entity_mark_due AFTER INSERT OR UPDATE ON "Entity"
  FOR EACH ROW EXECUTE FUNCTION orbit_entity_mark_due();

-- Pause, mode or generation changes wake the project; marker-only updates do not.
CREATE FUNCTION orbit_project_mark_due() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'workDueAt') IS DISTINCT FROM (to_jsonb(OLD) - 'workDueAt') THEN
    NEW."workDueAt" := LEAST(NEW."workDueAt", now());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_mark_due BEFORE UPDATE ON "Project"
  FOR EACH ROW EXECUTE FUNCTION orbit_project_mark_due();
