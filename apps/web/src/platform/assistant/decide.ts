"use client";
import { useCallback } from "react";
import { collectionPath, post } from "@/lib/api";
import { useWorkspace } from "@/components/workspace-context";

/** The exact request an owner decides: its id, version and payload hash. */
export type DecidableRequest = {
  id: string;
  version: number;
  packageHash: string;
};

/**
 * One decision on an action request (ADR 0008), shared by the chat cards and
 * the approvals inbox (WP2.3). The image rights consent is sent only when
 * the caller gives one.
 */
export function useDecideActionRequest() {
  const { project } = useWorkspace();
  return useCallback(
    (
      request: DecidableRequest,
      decision: "approve" | "reject",
      imageRightsConsent?: boolean,
    ) =>
      post(collectionPath(project.id, `action-requests/${request.id}/decide`), {
        version: request.version,
        packageHash: request.packageHash,
        decision,
        ...(imageRightsConsent === undefined ? {} : { imageRightsConsent }),
      }),
    [project.id],
  );
}
