import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";

/** How a configuration field counts for this project right now. */
export type FieldRequirement = "required" | "optional" | "not_used";

/**
 * One part of a project's configuration that a module (or the platform)
 * owns (plans/project-configuration-mcp.md): it reads its values, and an
 * editable section validates and applies partial changes through its own
 * existing save path. Values never include secrets.
 */
export type ConfigurationSection = {
  label: { en: string; de: string };
  read(tx: DbTx, scope: Scope): Promise<{
    /** Raised by every write; 0 while nothing is stored. */
    version: number;
    values: Record<string, unknown>;
    fields: Record<string, { requirement: FieldRequirement; editable: boolean }>;
    /** Further facts a reader needs, such as the enabled campaign types. */
    notes?: Record<string, unknown>;
  }>;
  /** Checks a partial change against the stored values; throws when invalid. */
  validate?(tx: DbTx, scope: Scope, changes: Record<string, unknown>): Promise<void>;
  /** Applies a validated partial change through the section's save path. */
  apply?(tx: DbTx, scope: Scope, changes: Record<string, unknown>): Promise<void>;
};

/** A module's configuration sections, by section id. */
export type ConfigurationContribution = Readonly<
  Record<string, ConfigurationSection>
>;
