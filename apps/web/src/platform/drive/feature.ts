// Whether the shell lists the Drive page (design 2026-11-05 §5.2). The
// status reloads with the workspace revision (a connect, disconnect or root
// change in the settings refreshes it); while it reloads the last value of
// the same project stays, so the entry does not disappear for a moment.

export type DriveFeature = { projectId: string; enabled: boolean } | null;

export function driveFeature(
  prev: DriveFeature,
  projectId: string,
  status: { enabled: boolean } | null | undefined,
): DriveFeature {
  if (status) return { projectId, enabled: status.enabled === true };
  return prev?.projectId === projectId ? prev : null;
}
