-- Automation workflow bindings (ADR 0013, WP3.7): which workflow of an
-- automation connection (such as n8n) serves which product-neutral Orbit
-- contract. Using a binding needs a grant of its connection, so the
-- business role sees a binding exactly when it sees the connection.
-- Additive; down path: drop the table.

CREATE TABLE "WorkflowBinding" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "contract" TEXT NOT NULL,
    "workflowRef" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),
    CONSTRAINT "WorkflowBinding_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WorkflowBinding_contract_check" CHECK ("contract" IN ('automation.v1', 'customer_context.v1')),
    CONSTRAINT "WorkflowBinding_ref_check" CHECK ("workflowRef" ~ '^[A-Za-z0-9][A-Za-z0-9/_-]{0,199}$')
);
CREATE INDEX "WorkflowBinding_connectionId_idx" ON "WorkflowBinding"("connectionId");
ALTER TABLE "WorkflowBinding" ADD CONSTRAINT "WorkflowBinding_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkflowBinding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkflowBinding" FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_control ON "WorkflowBinding" TO orbit_auth USING (true) WITH CHECK (true);
CREATE POLICY binding_use ON "WorkflowBinding" FOR SELECT TO orbit_app USING (
  "revokedAt" IS NULL
  AND EXISTS (SELECT 1 FROM "Connection" c WHERE c."id" = "WorkflowBinding"."connectionId"));
