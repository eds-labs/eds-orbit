import { z } from "zod";

/** Versioned public projections: no private run payload, grant secret or model prompt. */
export const taskSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string(),
    projectId: z.string(),
    description: z.string(),
    requestedBy: z
      .object({ userId: z.string(), clientId: z.string() })
      .strict(),
    status: z.enum([
      "queued",
      "running",
      "succeeded",
      "failed",
      "blocked",
      "canceled",
      "awaiting_approval",
      "rejected",
      "expired",
    ]),
    phase: z.string(),
    agent: z.string(),
    agents: z.array(
      z
        .object({ id: z.string(), name: z.string(), status: z.string() })
        .strict(),
    ),
    capabilitiesUsed: z.array(z.string()),
    modules: z.array(z.string()),
    conversationId: z.string(),
    runId: z.string().nullable(),
    approvals: z.array(
      z
        .object({
          actionRequestId: z.string(),
          actionType: z.string(),
          status: z.string(),
          approveUrl: z.string(),
        })
        .strict(),
    ),
    artifacts: z.array(
      z
        .object({
          id: z.string(),
          kind: z.string(),
          status: z.string().nullable(),
          body: z.string().optional(),
        })
        .strict(),
    ),
    blockers: z.array(z.string()),
    errorCode: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    completedAt: z.string().nullable(),
    result: z.string().nullable(),
    resourceUri: z.string(),
    url: z.string(),
  })
  .strict();
