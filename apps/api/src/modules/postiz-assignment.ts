import { z } from "zod";
import { authDb, type DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { audit, data, DomainError, entity, list, update } from "../shared.ts";

export const postizAssignmentInput = z
  .object({
    connectorId: z.uuid(),
    version: z.number().int().positive(),
    integrationIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)).max(20),
  })
  .strict();

export function assignedPostizChannels(connector: Record<string, any>) {
  const assigned = Array.isArray(connector.assignedIntegrationIds)
    ? connector.assignedIntegrationIds
    : [];
  return (Array.isArray(connector.channels) ? connector.channels : []).filter(
    (channel: any) =>
      typeof channel?.id === "string" &&
      !channel.disabled &&
      assigned.includes(channel.id),
  );
}

export function isAssignedPostizChannel(
  connector: Record<string, any>,
  integrationId: string,
) {
  return assignedPostizChannels(connector).some(
    (channel: any) => channel.id === integrationId,
  );
}

export async function assertAssignedSocialChannels(
  tx: DbTx,
  scope: Scope,
  integrationIds: string[],
) {
  const connectors = (await list(tx, scope, "connectors")).filter(
    (row) =>
      data(row).provider === "postiz" &&
      ["read_verified", "write_verified"].includes(data(row).status),
  );
  const assigned = new Set(
    connectors.flatMap((row) =>
      assignedPostizChannels(data(row)).map((channel: any) => channel.id),
    ),
  );
  if (integrationIds.some((id) => !assigned.has(id)))
    throw new DomainError("POSTIZ_CHANNEL_NOT_ASSIGNED", 409);
}

export async function assignPostizChannels(
  tx: DbTx,
  scope: Scope,
  raw: z.input<typeof postizAssignmentInput>,
) {
  if (
    scope.role !== "owner" ||
    !(await authDb.project.findFirst({
      where: {
        id: scope.projectId,
        workspaceId: scope.workspaceId,
        OR: [
          {
            workspace: {
              members: { some: { userId: scope.userId, role: "owner" } },
            },
          },
          { members: { some: { userId: scope.userId, role: "owner" } } },
        ],
      },
      select: { id: true },
    }))
  )
    throw new DomainError("OWNER_REQUIRED", 403);
  const input = postizAssignmentInput.parse(raw);
  const row = await entity(tx, scope, "connectors", input.connectorId);
  if (row.version !== input.version)
    throw new DomainError("VERSION_CONFLICT", 409);
  const connector = data(row);
  if (
    connector.provider !== "postiz" ||
    !["read_verified", "write_verified"].includes(connector.status)
  )
    throw new DomainError("POSTIZ_READ_VERIFICATION_REQUIRED", 409);
  const available = new Set(
    (Array.isArray(connector.channels) ? connector.channels : [])
      .filter((channel: any) => channel && !channel.disabled)
      .map((channel: any) => channel.id),
  );
  if (
    new Set(input.integrationIds).size !== input.integrationIds.length ||
    input.integrationIds.some((id) => !available.has(id))
  )
    throw new DomainError("POSTIZ_ACCOUNT_UNAVAILABLE", 409);
  const integrationIds = [...input.integrationIds].sort();
  const updated = await update(tx, scope, row, {
    ...connector,
    assignedIntegrationIds: integrationIds,
  });
  await audit(tx, scope, "postiz.channels_assigned", row.id, {
    integrationIds,
  });
  return updated;
}
