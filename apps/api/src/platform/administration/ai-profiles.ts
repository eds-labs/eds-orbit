import { authDb, type Prisma } from "../../../../../packages/db/src/index.ts";
import { aiProfileInput } from "../ai/central-ai.ts";
import { systemAudit } from "./audit.ts";

// The system's and an organization's AI profile (ADR 0014): models, rate
// cards, routes and defaults, never keys (those are connections). A
// project's own AI settings still override them; every save changes the
// route version, so in-flight runs stop before their next paid call.

type Target = { scope: "system" } | { scope: "workspace"; workspaceId: string };

const where = (t: Target) =>
  t.scope === "system"
    ? { scope: "system", workspaceId: null }
    : { scope: "workspace", workspaceId: t.workspaceId };

export async function aiProfile(target: Target) {
  const row = await authDb.aiProfile.findFirst({ where: where(target) });
  return {
    scope: target.scope,
    version: row?.version ?? 0,
    data: row?.data ?? {},
    updatedAt: row?.updatedAt ?? null,
  };
}

export async function saveAiProfile(
  actorId: string,
  target: Target,
  raw: unknown,
) {
  const data = aiProfileInput.parse(raw) as Prisma.InputJsonValue;
  return authDb.$transaction(async (tx) => {
    const current = await tx.aiProfile.findFirst({ where: where(target) });
    const saved = current
      ? await tx.aiProfile.update({
          where: { id: current.id },
          data: {
            data,
            version: { increment: 1 },
            updatedBy: actorId,
            updatedAt: new Date(),
          },
        })
      : await tx.aiProfile.create({
          data: { ...where(target), data, updatedBy: actorId },
        });
    await systemAudit(
      {
        actorId,
        action: "ai_profile.updated",
        targetType: "ai_profile",
        targetId: saved.id,
        workspaceId: saved.workspaceId,
        metadata: {
          scope: target.scope,
          version: saved.version,
          fields: Object.keys(data as object),
        },
      },
      tx,
    );
    return {
      scope: target.scope,
      version: saved.version,
      data: saved.data,
      updatedAt: saved.updatedAt,
    };
  });
}
