-- Platform prerequisites of the finance module. Additive; no existing row is
-- changed.

-- Retention lock for platform files: a file with a future "retainUntil"
-- cannot be deleted through the files service (NULL = no retention).
ALTER TABLE "File" ADD COLUMN "retainUntil" timestamptz(3);
