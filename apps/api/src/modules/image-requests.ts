import { scoped, type DbTx } from "../../../../packages/db/src/index.ts";
import { generateImage } from "../../../../packages/ai/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { data, DomainError } from "../shared.ts";
import {
  consumeActionRequest,
  createActionRequest,
  executableActionRequest,
  type RequestedBy,
} from "./action-requests.ts";
import {
  currentImageTerms,
  generateProjectImage,
  imageRequestBrief,
  imageRequestPayload,
} from "./image-generation.ts";
import { actorScope } from "./member-scope.ts";

/** Creates a pending image request bound to the image model and ceiling configured now. */
export async function proposeImageRequest(
  tx: DbTx,
  scope: Scope,
  brief: unknown,
  requestedBy: RequestedBy,
  options: { budgetRunKey?: string } = {},
) {
  const { imageConfig } = await currentImageTerms(tx, scope);
  return createActionRequest(tx, scope, {
    actionType: "image.generate",
    payload: {
      ...imageRequestBrief.parse(brief),
      model: imageConfig.model,
      maxCostMicros: imageConfig.maxCostMicrosPerImage,
      ...(options.budgetRunKey ? { budgetRunKey: options.budgetRunKey } : {}),
    },
    requestedBy,
  });
}

/** Worker entry: runs an approved image request with the decider's current project role. */
export async function runImageJob(
  base: Scope,
  actorId: unknown,
  actionRequestId: string,
  jobId: string,
  provider = generateImage,
) {
  const actor =
    typeof actorId === "string" && actorId
      ? await actorScope(base.workspaceId, base.projectId, actorId)
      : null;
  if (!actor) throw new DomainError("ACTOR_MEMBERSHIP_REQUIRED", 403);
  if (actor.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  return executeImageRequest(actor, actionRequestId, jobId, provider);
}

/**
 * Executes an approved image request at most once. The approval is consumed
 * in the reservation transaction after every other check passed; a
 * reservation without an asset is an unknown outcome and is never resent.
 */
export async function executeImageRequest(
  scope: Scope,
  actionRequestId: string,
  executionId: string,
  provider = generateImage,
) {
  const prepared = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const asset = await tx.entity.findFirst({
        where: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: "assets",
          data: { path: ["generationId"], equals: actionRequestId },
        },
      });
      if (asset) return { asset };
      const request = await executableActionRequest(
        tx,
        scope,
        actionRequestId,
        executionId,
      );
      const reservation = await tx.budgetReservation.findFirst({
        where: {
          projectId: scope.projectId,
          key: `${scope.projectId}:image:${actionRequestId}`,
        },
      });
      if (reservation) throw new DomainError("IMAGE_OUTCOME_UNKNOWN", 409);
      return { request };
    },
  );
  if (prepared.asset) return prepared.asset;
  const request = data(prepared.request);
  const { model, maxCostMicros, budgetRunKey, ...brief } =
    imageRequestPayload.parse(request.payload);
  return generateProjectImage(
    scope,
    {
      ...brief,
      requestId: actionRequestId,
      // These confirmations come from the owner's recorded decision on this exact payload.
      confirmPromptMayBeSentToOpenAI: true,
      confirmMaximumCostMicros: maxCostMicros,
    },
    provider,
    {
      runKey: budgetRunKey,
      authorize: async (tx) => {
        const { imageConfig } = await currentImageTerms(tx, scope);
        if (imageConfig.model !== model)
          throw new DomainError("IMAGE_REQUEST_STALE", 409);
        await consumeActionRequest(
          tx,
          scope,
          actionRequestId,
          executionId,
          request.packageHash,
        );
      },
    },
  );
}
