-- Support AI (WP5.6): telemetry runs of support triage and draft replies.
-- Widens the check only.
ALTER TABLE "AgentRun" DROP CONSTRAINT "AgentRun_kind_check";
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_kind_check" CHECK ("kind" IN ('chat','generation','retrieval','ingestion','reindex','evaluation','image','agent','support'));
