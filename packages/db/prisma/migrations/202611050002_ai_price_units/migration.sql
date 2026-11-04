-- Agent platform Phase 4 (ADR 0024): prices per audio minute or character
-- for speech models. Additive: every existing price keeps unit 'token' and
-- its token rates, so text reservation and settlement are unchanged. Down
-- path before first use: drop the check and the two columns.
ALTER TABLE "AiModelPrice" ADD COLUMN "unit" TEXT NOT NULL DEFAULT 'token';
ALTER TABLE "AiModelPrice" ADD COLUMN "unitPriceMicros" DECIMAL(18,6);
ALTER TABLE "AiModelPrice" ADD CONSTRAINT "AiModelPrice_unit_check" CHECK (
  ("unit" = 'token') OR ("unit" IN ('audio_minute','character') AND "unitPriceMicros" IS NOT NULL AND "unitPriceMicros" >= 0)
);
