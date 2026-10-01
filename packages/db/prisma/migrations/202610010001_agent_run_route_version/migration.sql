-- Records which OpenAI configuration version routed a run. Additive only.
ALTER TABLE "AgentRun" ADD COLUMN "routeVersion" INTEGER;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_routeVersion_check" CHECK ("routeVersion" IS NULL OR "routeVersion" > 0);
