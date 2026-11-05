-- Agent platform Phase 3 (ADR 0022, T3-2): the platform writes `notice`
-- messages into a personal conversation when delegated work orders finish,
-- without a model call. Additive: existing messages keep 'user' or
-- 'assistant'. Down path before first use: delete notice messages, restore
-- the check to ('user','assistant').
ALTER TABLE "ChatMessage" DROP CONSTRAINT "ChatMessage_role_check";
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_role_check" CHECK ("role" IN ('user','assistant','notice'));
