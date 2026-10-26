import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { CONNECTION_KIND } from "../../platform/connections/connections.ts";
import { audit, create, credentialKey, data, DomainError, encrypt, entity, list, update } from "../../shared.ts";
import { uuid } from "./common.ts";
import { ISSUES_HOOK, ISSUES_WEBHOOK_PROVIDER } from "./sources/webhook.ts";

// Inbound report sources (plan §4.2 /sources): per-project webhook
// connections with a signing secret Orbit generates. The secret is shown
// once, when the source is created; no view returns it again.

const createInput = z
  .object({
    name: z.string().trim().min(1).max(60),
    kind: z.enum(["webhook", "n8n"]).default("webhook"),
  })
  .strict();

const sourceView = (row: { id: string; createdAt: Date; data: unknown }, scope: Scope) => {
  const d = data(row);
  return {
    id: row.id,
    name: String(d.name ?? ""),
    kind: d.sourceKind === "n8n" ? "n8n" : "webhook",
    status: String(d.status ?? "configured"),
    path: `/api/hooks/${ISSUES_HOOK}/${scope.workspaceId}/${scope.projectId}/${row.id}`,
    createdAt: row.createdAt.toISOString(),
  };
};

export async function listSources(tx: DbTx, scope: Scope) {
  return (await list(tx, scope, CONNECTION_KIND))
    .filter((row) => data(row).provider === ISSUES_WEBHOOK_PROVIDER && data(row).status !== "disabled")
    .map((row) => sourceView(row, scope));
}

/** Creates a source and returns its signing secret, this once. */
export async function createSource(tx: DbTx, scope: Scope, raw: unknown) {
  const input = createInput.parse(raw);
  if ((await listSources(tx, scope)).length >= 20) throw new DomainError("ISSUES_SOURCES_LIMIT", 409);
  const secret = randomBytes(32).toString("base64url");
  const row = await create(tx, scope, CONNECTION_KIND, {
    provider: ISSUES_WEBHOOK_PROVIDER,
    name: input.name,
    sourceKind: input.kind,
    status: "configured",
    capabilities: ["inbound"],
    encryptedCredential: encrypt(secret, credentialKey()),
  });
  await audit(tx, scope, "issues.source.created", row.id, { kind: input.kind });
  return { ...sourceView(row, scope), secret };
}

/** Switches a source off for good: its secret is dropped, deliveries fail. */
export async function disableSource(tx: DbTx, scope: Scope, id: string) {
  const row = await entity(tx, scope, CONNECTION_KIND, uuid.parse(id));
  const d = data(row);
  if (d.provider !== ISSUES_WEBHOOK_PROVIDER) throw new DomainError("NOT_FOUND", 404);
  const { encryptedCredential: _secret, ...rest } = d;
  await update(tx, scope, row, { ...rest, status: "disabled", disabledAt: new Date().toISOString() });
  // Earlier versions of the row held the encrypted secret too.
  await tx.entityVersion.updateMany({
    where: { entityId: row.id, projectId: scope.projectId },
    data: { data: { ...rest, status: "disabled" } },
  });
  await audit(tx, scope, "issues.source.disabled", row.id, {});
  return { id: row.id, disabled: true };
}
