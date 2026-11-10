-- Social posts (ADR 0020, S4): the base text and images a post's variants
-- inherit unless they override them, so inheritance survives later edits.
-- Text limits match the largest platform text (X Premium, 25,000).

ALTER TABLE "SocialPost"
  ADD COLUMN "baseText" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "baseMedia" JSONB NOT NULL DEFAULT '[]',
  ADD CONSTRAINT "SocialPost_baseText_check" CHECK (char_length("baseText") <= 25000),
  ADD CONSTRAINT "SocialPost_baseMedia_check" CHECK (jsonb_typeof("baseMedia") = 'array' AND jsonb_array_length("baseMedia") <= 10),
  ADD CONSTRAINT "SocialPost_title_check" CHECK ("title" IS NULL OR char_length("title") <= 200);

ALTER TABLE "SocialPostVariant"
  ADD COLUMN "inheritsText" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "inheritsMedia" BOOLEAN NOT NULL DEFAULT true,
  ADD CONSTRAINT "SocialPostVariant_body_check" CHECK (char_length("body") <= 25000);

-- Removing a library image counts the posts that use its files.
CREATE INDEX "SocialPostMedia_project_file_idx" ON "SocialPostMedia"("projectId", "fileId");
