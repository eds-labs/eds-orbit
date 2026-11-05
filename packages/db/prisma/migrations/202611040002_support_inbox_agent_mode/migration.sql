-- Agent platform Phase 2 (ADR 0021 D-15): an inbox can hand its automatic
-- triage and drafting to a configured Support agent. Additive: existing
-- inboxes keep 'off' or 'draft'.
ALTER TABLE "SupportInbox" DROP CONSTRAINT "SupportInbox_aiMode_check";
ALTER TABLE "SupportInbox" ADD CONSTRAINT "SupportInbox_aiMode_check" CHECK ("aiMode" IN ('off','draft','agent'));
