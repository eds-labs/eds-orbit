-- Several mailboxes per project: an e-mail inbox is bound to one e-mail
-- connection (a `connectors` entity with provider "email") of the same
-- project. Additive: one nullable column, a same-project composite foreign
-- key (foreign key checks bypass RLS, so the key itself keeps the binding
-- inside one project) and a partial unique index, so no two live inboxes
-- share one mailbox. The existing row-level security policy and grants of
-- "SupportInbox" cover the new column.
ALTER TABLE "SupportInbox" ADD COLUMN "emailConnectionId" UUID;

ALTER TABLE "SupportInbox" ADD CONSTRAINT "SupportInbox_emailConnection_fkey"
  FOREIGN KEY ("projectId", "emailConnectionId") REFERENCES "Entity"("projectId", "id");

CREATE UNIQUE INDEX "SupportInbox_emailConnection_live_key"
  ON "SupportInbox"("projectId", "emailConnectionId")
  WHERE "archivedAt" IS NULL AND "emailConnectionId" IS NOT NULL;

-- Backfill: a live e-mail inbox is bound to the e-mail connection of its
-- project whose address is the inbox's address (the oldest verified row of
-- that address, the row the platform has used so far). Only the oldest live
-- inbox of an address is bound; inboxes without a matching connection stay
-- unbound and keep the single-mailbox behaviour (docs/SUPPORT.md).
WITH candidates AS (
  SELECT DISTINCT ON (i."projectId", lower(i."emailAddress"))
         i.id AS inbox_id,
         (SELECT e.id
            FROM "Entity" e
           WHERE e."projectId" = i."projectId"
             AND e.kind = 'connectors'
             AND e.data->>'provider' = 'email'
             AND lower(e.data->>'fromAddress') = lower(i."emailAddress")
           ORDER BY (e.data->>'status' IN ('read_verified', 'write_verified')) DESC,
                    e."createdAt", e.id
           LIMIT 1) AS connection_id
    FROM "SupportInbox" i
   WHERE i."archivedAt" IS NULL
     AND i."emailConnectionId" IS NULL
     AND 'email' = ANY (i.channels)
     AND i."emailAddress" IS NOT NULL
   ORDER BY i."projectId", lower(i."emailAddress"), i."createdAt", i.id
)
UPDATE "SupportInbox" s
   SET "emailConnectionId" = c.connection_id
  FROM candidates c
 WHERE s.id = c.inbox_id
   AND c.connection_id IS NOT NULL;
