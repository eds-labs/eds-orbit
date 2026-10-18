-- MCP gateway (Track M, WP-M2): telemetry runs of tool calls from outside
-- MCP clients. Widens the check only.
ALTER TABLE "AgentRun" DROP CONSTRAINT "AgentRun_kind_check";
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_kind_check" CHECK ("kind" IN ('chat','generation','retrieval','ingestion','reindex','evaluation','image','agent','support','mcp'));
