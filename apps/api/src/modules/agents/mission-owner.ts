import { DomainError } from "../../shared.ts";

export const ASSIGNMENT_MISSION_OWNED = "ASSIGNMENT_MISSION_OWNED";

/**
 * An assignment run's mission is drafted only by its copywriter task, under
 * the task's budget attribution (R37): `jobId` must be one of that task's
 * jobs (`agent:<agentTaskId>:…`). Without a job (manual run, live draft or
 * batch entries) every assignment mission is refused.
 */
export function assertMissionDraftOwner(
  mission: Record<string, any>,
  jobId?: string,
) {
  if (!mission.assignmentRunId) return;
  if (
    jobId &&
    typeof mission.agentTaskId === "string" &&
    jobId.startsWith(`agent:${mission.agentTaskId}:`)
  )
    return;
  throw new DomainError(ASSIGNMENT_MISSION_OWNED, 409);
}
