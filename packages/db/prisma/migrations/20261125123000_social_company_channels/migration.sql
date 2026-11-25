ALTER TABLE "SocialAccount"
  DROP CONSTRAINT "SocialAccount_platform_check",
  ADD CONSTRAINT "SocialAccount_platform_check"
    CHECK ("platform" IN ('instagram','facebook','x','telegram','linkedin','tiktok','youtube'));

ALTER TABLE "SocialOAuthState"
  DROP CONSTRAINT "SocialOAuthState_platform_check",
  ADD CONSTRAINT "SocialOAuthState_platform_check"
    CHECK ("platform" IN ('instagram','facebook','x','telegram','linkedin','tiktok','youtube'));

ALTER TABLE "SocialMediaAsset"
  ADD COLUMN "durationMs" integer,
  DROP CONSTRAINT "SocialMediaAsset_mime_check",
  ADD CONSTRAINT "SocialMediaAsset_mime_check" CHECK (
    ("mime" IN ('image/png','image/jpeg') AND "durationMs" IS NULL) OR
    ("mime" = 'video/mp4' AND "durationMs" IS NOT NULL AND "durationMs" BETWEEN 1 AND 60000
      AND "jpegFileId" = "fileId" AND "jpegWidth" = "width" AND "jpegHeight" = "height" AND "jpegSize" = "size")
  );
