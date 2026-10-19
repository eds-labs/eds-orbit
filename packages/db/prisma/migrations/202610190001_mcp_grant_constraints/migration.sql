-- MCP grants (Track M, WP-M5 pre-flip). Additive: one nullable column, one
-- CHECK constraint and one index; no existing row is changed.
-- Before applying in production, check read-only that no row violates the
-- constraint (expected result: 0):
--   SELECT count(*) FROM "McpGrant" WHERE "status" NOT IN ('pending','active','revoked');

-- The authorization request a selection was made for (a fingerprint of its
-- parameters, never token material); a selection only serves that request.
ALTER TABLE "McpGrant" ADD COLUMN "requestHash" TEXT;

ALTER TABLE "McpGrant" ADD CONSTRAINT "McpGrant_status_check" CHECK ("status" IN ('pending','active','revoked'));

-- CreateIndex
CREATE INDEX "McpGrant_sessionId_idx" ON "McpGrant"("sessionId");
