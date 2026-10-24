import { canonical, DomainError } from "../shared.ts";

// The exact settings an administration proposal changes
// (docs/MCP_PROJECT_ADMINISTRATION.md). Computed when the proposal is saved,
// shown to the owner with it, and computed again at approval: a proposal
// whose change would now differ from what the owner saw is refused.

export type SettingChange = { setting: string; from: unknown; to: unknown };

/** The settings whose values differ between `before` and `after`, in key order. */
export function settingChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix = "",
): SettingChange[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((key) => canonical(before[key] ?? null) !== canonical(after[key] ?? null))
    .map((key) => ({
      setting: prefix + key,
      from: before[key] ?? null,
      to: after[key] ?? null,
    }));
}

/** Refuses an empty change; a proposal must change at least one setting. */
export function requireChanges(changes: SettingChange[]) {
  if (!changes.length) throw new DomainError("CONFIGURATION_CHANGES_REQUIRED", 400);
  return changes;
}

/** Refuses an approval whose change no longer matches the one proposed. */
export function assertSameChanges(saved: unknown, current: SettingChange[]) {
  const proposed = (saved as { changes?: unknown } | null)?.changes;
  if (canonical(proposed ?? null) !== canonical(current))
    throw new DomainError("PROPOSED_CHANGE_OUTDATED", 409);
}
