import { authDb, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { notifyMembers } from "../notifications/members.ts";
import { actorScope } from "../tenancy/member-scope.ts";
import { effectiveRole } from "../tenancy/module-roles.ts";
import { can } from "../tenancy/permissions.ts";
import { registeredUserNotification } from "../modules/contributions.ts";
import { proactiveEnabled } from "../proactive/preferences.ts";
import { signalSwitchedOff } from "./settings.ts";
import type {
  SignalDefinition,
  SignalFinding,
  SignalParams,
  SignalRecipients,
} from "./types.ts";

// From a detector's findings to member notifications (ADR 0023 items 1-3):
// the per-project switch, recipients resolved with their current
// membership and module role, a title rendered from the signal's template
// in each recipient's language, and `notifyMembers` with the finding's
// fingerprint as the dedupe key. No AI, no free text.

type Locale = "en" | "de";

/** A title template with `{name}` parameters; unknown names stay empty. */
export function renderTitle(
  def: Pick<SignalDefinition, "titles" | "title">,
  key: string,
  params: SignalParams,
  locale: Locale,
) {
  const template = def.titles?.[key]?.[locale] ?? def.title[locale];
  return template
    .replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name: string) =>
      params[name] === undefined ? "" : String(params[name]),
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * The users a finding goes to, with their current access in the project and
 * the kind's module. Named users are checked by `notifyMembers` itself;
 * role, permission and organization-owner recipients are resolved here.
 */
export async function resolveRecipients(
  scope: Scope,
  recipients: SignalRecipients,
  moduleId: string,
): Promise<string[]> {
  const out = new Set<string>(recipients.userIds ?? []);
  if (recipients.organizationOwners) {
    const owners = await authDb.workspaceMember.findMany({
      where: { workspaceId: scope.workspaceId, role: "owner" },
      select: { userId: true },
    });
    for (const owner of owners) {
      const member = await actorScope(scope.workspaceId, scope.projectId, owner.userId);
      if (member && effectiveRole(member, moduleId) !== "none") out.add(owner.userId);
    }
  }
  if (recipients.roles?.length || recipients.permission) {
    const project = await authDb.project.findFirst({
      where: { id: scope.projectId },
      select: { kind: true },
    });
    const [owners, members] = await Promise.all([
      // A personal space has no implicit organization owners (ADR 0022).
      project?.kind === "personal"
        ? Promise.resolve([] as { userId: string }[])
        : authDb.workspaceMember.findMany({
            where: { workspaceId: scope.workspaceId, role: "owner" },
            select: { userId: true },
          }),
      authDb.projectMember.findMany({
        where: { projectId: scope.projectId },
        select: { userId: true },
      }),
    ]);
    const candidates = new Set([...owners, ...members].map((m) => m.userId));
    for (const userId of candidates) {
      const member = await actorScope(scope.workspaceId, scope.projectId, userId);
      if (!member) continue;
      const role = effectiveRole(member, moduleId);
      if (role === "none") continue;
      if (recipients.roles?.length && !recipients.roles.includes(role)) continue;
      if (recipients.permission && !can({ role }, recipients.permission)) continue;
      out.add(userId);
    }
  }
  return [...out].filter(Boolean);
}

/**
 * Writes the findings of one signal as deduplicated member notifications.
 * Nothing while ORBIT_PROACTIVE is off or the signal is switched off in the
 * project. Returns how many notices were written or repeated.
 */
export async function deliverFindings(
  tx: DbTx,
  scope: Scope,
  def: SignalDefinition & { owner: string },
  findings: readonly SignalFinding[],
) {
  if (!proactiveEnabled() || !findings.length) return 0;
  if (await signalSwitchedOff(tx, scope, def.key)) return 0;
  const kind = registeredUserNotification(def.kind);
  if (!kind) return 0;
  const project = await tx.project.findFirst({
    where: { id: scope.projectId },
    select: { language: true },
  });
  const fallback: Locale = project?.language === "de" ? "de" : "en";
  let written = 0;
  for (const finding of findings) {
    const userIds = await resolveRecipients(scope, finding.recipients, kind.owner);
    if (!userIds.length) continue;
    const users = await authDb.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, locale: true },
    });
    for (const locale of ["en", "de"] as const) {
      const group = users
        .filter((u) => (u.locale === "de" || u.locale === "en" ? u.locale : fallback) === locale)
        .map((u) => u.id);
      for (let i = 0; i < group.length; i += 200) {
        const result = await notifyMembers(tx, scope, {
          kind: def.kind,
          userIds: group.slice(i, i + 200),
          title: renderTitle(def, finding.titleKey, finding.params, locale),
          link: finding.link,
          dedupeKey: finding.fingerprint,
          severity: finding.severity,
        });
        written += result.inApp;
      }
    }
  }
  return written;
}
