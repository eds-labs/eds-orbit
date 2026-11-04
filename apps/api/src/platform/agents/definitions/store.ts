import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { DomainError, entity } from "../../shared.ts";
import { AGENT_DEFINITIONS, AgentDefinition } from "./schema.ts";

/**
 * Reads one agent definition of the project and checks its stored shape
 * (ADR 0021, plan §2.2). The definition service (WP1.5) builds on this;
 * permission checks stay with its callers.
 */
export async function readAgentDefinition(
  tx: DbTx,
  scope: Pick<Scope, "workspaceId" | "projectId">,
  id: string,
) {
  const row = await entity(tx, scope, AGENT_DEFINITIONS, id).catch(
    (error: unknown) => {
      if (error instanceof DomainError && error.code === "NOT_FOUND")
        throw new DomainError("AGENT_NOT_FOUND", 404);
      throw error;
    },
  );
  const parsed = AgentDefinition.safeParse(row.data);
  if (!parsed.success) throw new DomainError("AGENT_DEFINITION_INVALID", 409);
  return { id: row.id, version: row.version, definition: parsed.data };
}
