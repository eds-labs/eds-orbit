-- Support automations (WP5.5): per-inbox switches over the project's support
-- settings (auto-acknowledgement, auto-close and its days, reopen on reply,
-- SLA timers). An empty object keeps the project defaults. Additive.
ALTER TABLE "SupportInbox" ADD COLUMN "rules" JSONB NOT NULL DEFAULT '{}';
