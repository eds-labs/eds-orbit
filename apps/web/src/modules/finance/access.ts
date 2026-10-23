import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";

/**
 * What the member may do here: `owner` manages settings, `editor` also
 * writes categories and cost centers. The module role the server advertises
 * wins; without it the project role decides.
 */
export function useFinanceAccess() {
  const { isOwner, canEdit } = useWorkspace();
  const access = useShell().modules.find((m) => m.id === "finance")?.access;
  const owner = access ? access === "owner" : isOwner;
  const write = access ? ["owner", "editor"].includes(access) : canEdit;
  // finance.export is granted to the same roles as finance.write.
  return { owner, write, canExport: write };
}
