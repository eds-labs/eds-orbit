import { randomUUID } from "node:crypto";
import type { InstagramWorkflow, InstagramWorkflowStore } from "@opencoredev/social-sdk/instagram";
import { Prisma, scoped } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../../../shared.ts";

// Durable state of multi-step platform flows (ADR 0020, S5), such as
// Instagram's media containers, so a retry after a crash continues the flow
// instead of starting a second one. Writes are compare-and-set on the
// revision; a lease lets one worker continue a flow at a time. Every call is
// its own short transaction: the SDK calls the store while a provider
// request is in flight, outside any Orbit transaction. No tokens are stored.

type Body = Record<string, unknown>;
const conflict = () => new DomainError("SOCIAL_PROVIDER_STATE_CONFLICT", 409);

export function providerStateStore(scope: Scope, namespace: string) {
  const run = <T>(work: Parameters<typeof scoped<T>>[2]) => scoped(scope.workspaceId, scope.projectId, work);
  const where = (recordKey: string) => ({
    projectId_namespace_recordKey: { projectId: scope.projectId, namespace, recordKey },
  });
  return {
    async read(key: string): Promise<{ revision: number; body: Body } | null> {
      const row = await run((tx) => tx.socialProviderState.findUnique({ where: where(key) }));
      return row ? { revision: row.revision, body: row.body as Body } : null;
    },
    async create(key: string, body: Body): Promise<void> {
      try {
        await run((tx) =>
          tx.socialProviderState.create({
            data: {
              workspaceId: scope.workspaceId,
              projectId: scope.projectId,
              namespace,
              recordKey: key,
              body: body as Prisma.InputJsonValue,
            },
          }),
        );
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw conflict();
        throw error;
      }
    },
    /** Merges `patch` when `revision` is the stored one; returns the new revision. */
    async update(key: string, revision: number, patch: Body): Promise<number> {
      return run(async (tx) => {
        const row = await tx.socialProviderState.findUnique({ where: where(key) });
        if (!row || row.revision !== revision) throw conflict();
        const changed = await tx.socialProviderState.updateMany({
          where: { projectId: scope.projectId, namespace, recordKey: key, revision },
          data: { body: { ...(row.body as Body), ...patch } as Prisma.InputJsonValue, revision: revision + 1 },
        });
        if (changed.count !== 1) throw conflict();
        return revision + 1;
      });
    },
    /** A lease token, or null while another holder's lease runs (or the record is missing). */
    async claim(key: string, ttlMs: number): Promise<string | null> {
      const token = randomUUID();
      const now = new Date();
      const changed = await run((tx) =>
        tx.socialProviderState.updateMany({
          where: {
            projectId: scope.projectId,
            namespace,
            recordKey: key,
            OR: [{ leaseToken: null }, { leaseExpiresAt: { lt: now } }],
          },
          data: { leaseToken: token, leaseExpiresAt: new Date(now.getTime() + ttlMs) },
        }),
      );
      return changed.count === 1 ? token : null;
    },
    async release(key: string, token: string): Promise<void> {
      await run((tx) =>
        tx.socialProviderState.updateMany({
          where: { projectId: scope.projectId, namespace, recordKey: key, leaseToken: token },
          data: { leaseToken: null, leaseExpiresAt: null },
        }),
      );
    },
  };
}

const CLAIM_MS = 5 * 60_000;

/**
 * The SDK's Instagram workflow store on PostgreSQL: one workflow per
 * publication (id `pub_<publicationId>`), so a retry can only continue it.
 */
export function instagramWorkflowStore(scope: Scope, publicationId: string): InstagramWorkflowStore {
  const store = providerStateStore(scope, "instagram-workflow");
  const tokens = new Map<string, string>();
  const get = async (id: string) => (await store.read(id))?.body as InstagramWorkflow | undefined;
  return {
    async create(input) {
      const workflow = { ...input, id: `pub_${publicationId}` } as InstagramWorkflow;
      await store.create(workflow.id, workflow as unknown as Body);
      return workflow;
    },
    get,
    async update(id, patch) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await store.read(id);
        if (!current) throw new Error("Instagram workflow not found");
        try {
          await store.update(id, current.revision, { ...patch, id });
          return { ...(current.body as unknown as InstagramWorkflow), ...patch, id };
        } catch (error) {
          if ((error as { code?: string }).code !== "SOCIAL_PROVIDER_STATE_CONFLICT") throw error;
        }
      }
      throw conflict();
    },
    async claim(id) {
      const token = await store.claim(id, CLAIM_MS);
      if (token) tokens.set(id, token);
      return token !== null;
    },
    async release(id) {
      const token = tokens.get(id);
      tokens.delete(id);
      if (token) await store.release(id, token);
    },
  };
}
