-- Telemetry runs of the AI project manager (ADR 0017). Widens the check
-- only; no existing row is changed.
ALTER TABLE "AgentRun" DROP CONSTRAINT "AgentRun_kind_check";
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_kind_check" CHECK ("kind" IN ('chat','generation','retrieval','ingestion','reindex','evaluation','image','agent','support','mcp','finance','work_pm'));
