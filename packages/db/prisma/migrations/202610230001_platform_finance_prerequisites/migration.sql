-- Platform prerequisites of the finance module. Additive; no existing row is
-- changed.

-- Retention lock for platform files: a file with a future "retainUntil"
-- cannot be deleted through the files service (NULL = no retention).
ALTER TABLE "File" ADD COLUMN "retainUntil" timestamptz(3);

-- Telemetry runs of the finance module's document extraction. Widens the
-- check only.
ALTER TABLE "AgentRun" DROP CONSTRAINT "AgentRun_kind_check";
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_kind_check" CHECK ("kind" IN ('chat','generation','retrieval','ingestion','reindex','evaluation','image','agent','support','mcp','finance'));
