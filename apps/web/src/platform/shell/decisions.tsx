"use client";
import { ActionRequestInbox } from "@/components/action-request-inbox";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead } from "@/platform/ui/collection";

/** Shared action requests stay reachable independently of any product module. */
export function Decisions() {
  const { locale } = useWorkspace();
  const de = locale === "de";
  return (
    <>
      <PageHead
        title={de ? "Freigaben" : "Approvals"}
        description={
          de
            ? "Entscheidungen zu Support-Nachrichten und anderen App-Aktionen."
            : "Decisions for support messages and other app actions."
        }
      />
      <ActionRequestInbox showEmpty />
    </>
  );
}
