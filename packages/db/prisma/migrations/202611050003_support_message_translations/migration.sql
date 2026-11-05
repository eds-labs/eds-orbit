-- Support UI improvements (2026-11-05): an internal AI note (the triage
-- summary, the knowledge-gap note) carries its body per UI locale, for
-- example {"de": "…"}, so the team reads it in its own language; bodyText
-- stays the English original. Additive and nullable: existing rows behave as
-- before. Down path before first use: drop the column.
ALTER TABLE "SupportMessage" ADD COLUMN "bodyTranslations" JSONB;
