"use client";
import { useCallback, useContext } from "react";
import { collectionPath, post } from "@/lib/api";
import { WorkspaceContext } from "@/components/workspace-context";

/** The exact request an owner decides: its id, version and payload hash. */
export type DecidableRequest = {
  id: string;
  version: number;
  packageHash: string;
};

/** The decide request of one action request in one project (ADR 0008). */
export function decideActionRequest(
  projectId: string,
  request: DecidableRequest,
  decision: "approve" | "reject",
  imageRightsConsent?: boolean,
) {
  return post(
    collectionPath(projectId, `action-requests/${request.id}/decide`),
    {
      version: request.version,
      packageHash: request.packageHash,
      decision,
      ...(imageRightsConsent === undefined ? {} : { imageRightsConsent }),
    },
  );
}

/**
 * One decision on an action request (ADR 0008), shared by the chat cards and
 * the approvals inbox (WP2.3). The image rights consent is sent only when
 * the caller gives one. `projectId` names the request's project (WP3.5: a
 * personal assistant card decides in the card's project); without it the
 * open project is used.
 */
export function useDecideActionRequest(projectId?: string) {
  const workspace = useContext(WorkspaceContext);
  const target = projectId ?? workspace?.project.id;
  return useCallback(
    (
      request: DecidableRequest,
      decision: "approve" | "reject",
      imageRightsConsent?: boolean,
    ) => {
      if (!target) return Promise.reject(new Error("PROJECT_REQUIRED"));
      return decideActionRequest(target, request, decision, imageRightsConsent);
    },
    [target],
  );
}
