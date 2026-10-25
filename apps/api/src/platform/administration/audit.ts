import {
  authDb,
  type DbTx,
} from "../../../../../packages/db/src/index.ts";

// The append-only system audit (ADR 0013): who changed which user,
// organization, membership or invitation. Identifiers and codes only:
// never an address, a name, a token, a password or a free-text reason.

export type SystemAuditInput = {
  actorId: string;
  action: string;
  targetType:
    | "user"
    | "workspace"
    | "project"
    | "invitation"
    | "session"
    | "connection"
    | "grant"
    | "ai_profile"
    | "ai_model_price"
    | "knowledge_share";
  targetId: string;
  workspaceId?: string | null;
  projectId?: string | null;
  metadata?: Record<string, string | number | boolean | null | string[]>;
};

export async function systemAudit(
  input: SystemAuditInput,
  tx: Pick<DbTx, "systemAuditEvent"> = authDb,
) {
  await tx.systemAuditEvent.create({
    data: {
      actorId: input.actorId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      workspaceId: input.workspaceId ?? null,
      projectId: input.projectId ?? null,
      metadata: input.metadata ?? {},
    },
  });
}
