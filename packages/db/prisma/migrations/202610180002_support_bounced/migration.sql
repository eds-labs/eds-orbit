-- Support e-mail channel (WP5.3): a reply the mailbox accepted can still
-- bounce later; the message shows it. Widens one check constraint; no data
-- changes.
ALTER TABLE "SupportMessage" DROP CONSTRAINT "SupportMessage_deliveryState_check";
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_deliveryState_check"
  CHECK ("deliveryState" IS NULL OR "deliveryState" IN ('pending','sent','not_sent','rejected','unknown','delivered','bounced'));
