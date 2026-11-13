// Links to the settings center (ADR 0027): the one place where the API
// builds addresses below /manage, so every producer names a section the
// same way the web's `manageHref` does.

const enc = encodeURIComponent;

/** `/manage/p/<id>/<area>/…`; every segment is encoded. */
export function projectCenterLink(
  projectId: string,
  area: string,
  ...rest: string[]
): string {
  return ["/manage", "p", projectId, area, ...rest].map((part, i) => (i === 0 ? part : enc(part))).join("/");
}

/** `/manage/p/<id>/modules/<moduleId>/<section>`: a module's own settings section. */
export function moduleSectionLink(
  projectId: string,
  moduleId: string,
  section: string,
): string {
  return projectCenterLink(projectId, "modules", moduleId, section);
}

/**
 * Makes a link of an attention item or signal an absolute path. Most links
 * are relative to the project (`/finance/review`); a center address already
 * names its project and stays as it is.
 */
export function inProject(projectId: string, link: string): string {
  return link.startsWith("/manage/") ? link : `/p/${projectId}${link}`;
}

/** The budget section of the project's AI area (budget signal and attention items). */
export const aiBudgetLink = (projectId: string) =>
  projectCenterLink(projectId, "ai", "budget");

/** Where the Google Drive callback sends the browser back to (no origin, with the outcome). */
export const googleDriveReturnLink = (projectId: string, ready: boolean) =>
  `${projectCenterLink(projectId, "integrations", "google-drive")}?googleDrive=${ready ? "ready" : "choose-root"}`;
