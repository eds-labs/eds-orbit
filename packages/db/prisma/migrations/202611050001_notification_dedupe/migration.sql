-- Agent platform Phase 4 (ADR 0023): deduplicated member notifications.
-- A signal's fingerprint (with its period bucket) is the dedupe key; a
-- repeat increments `occurrences` on the open row. Additive: existing rows
-- have no key and behave as before. Down path before first use: drop the
-- index, the check and the four columns.
ALTER TABLE "Notification" ADD COLUMN "dedupeKey" TEXT;
ALTER TABLE "Notification" ADD COLUMN "occurrences" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Notification" ADD COLUMN "lastOccurredAt" TIMESTAMPTZ(3);
ALTER TABLE "Notification" ADD COLUMN "severity" TEXT NOT NULL DEFAULT 'info';
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_severity_check" CHECK ("severity" IN ('info','attention','urgent'));
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_occurrences_check" CHECK ("occurrences" >= 1);
CREATE UNIQUE INDEX "Notification_dedupe_key" ON "Notification"("projectId", "userId", "dedupeKey") WHERE "dedupeKey" IS NOT NULL;
