import {
  CAMPAIGN_TYPE_FIELDS,
  marketingProfile,
  marketingProfileRequirements,
} from "../../../../../../packages/schemas/src/index.ts";
import type { ConfigurationSection } from "../../../platform/configuration/types.ts";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  assertProfileReferences,
  currentMarketingProfile,
  saveMarketingProfile,
} from "./marketing-profile.ts";

// The Marketing profile as a section of the project configuration (plans/
// project-configuration-mcp.md). A partial change is merged onto the
// stored profile (visual identity field by field, the brand logos per role;
// null clears an optional field), validated with the same schema and
// references as the editor, and saved as a new profile version, which sends
// dependent drafts to review.

/** The stored profile with a partial change applied. */
export function mergeProfile(
  stored: Record<string, unknown>,
  changes: Record<string, unknown>,
) {
  const merged: Record<string, unknown> = { ...stored };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete merged[key];
    else if (
      key === "visualIdentity" &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const visual = {
        ...((stored.visualIdentity as Record<string, unknown>) ?? {}),
      };
      for (const [k, v] of Object.entries(value))
        if (v === null) delete visual[k];
        else if (
          k === "logos" &&
          v &&
          typeof v === "object" &&
          !Array.isArray(v)
        ) {
          // The brand logos change one role at a time; null clears a role.
          const logos = {
            ...((visual.logos as Record<string, unknown>) ?? {}),
          };
          for (const [role, logo] of Object.entries(v))
            if (logo === null) delete logos[role];
            else logos[role] = logo;
          visual.logos = logos;
        } else visual[k] = v;
      merged.visualIdentity = visual;
    } else merged[key] = value;
  }
  return merged;
}

async function merged(tx: DbTx, scope: Scope, changes: Record<string, unknown>) {
  const row = await currentMarketingProfile(tx, scope);
  const profile = marketingProfile.parse(
    mergeProfile((row?.data as Record<string, unknown>) ?? {}, changes),
  );
  await assertProfileReferences(tx, scope, profile);
  return { row, profile };
}

export const marketingConfigurationSection: ConfigurationSection = {
  label: { en: "Marketing profile", de: "Marketing-Profil" },
  async read(tx, scope) {
    const row = await currentMarketingProfile(tx, scope);
    const values = (row?.data as Record<string, unknown>) ?? {};
    const { campaignTypes, fields } = marketingProfileRequirements(values);
    return {
      version: row?.version ?? 0,
      values,
      fields: Object.fromEntries(
        Object.entries(fields).map(([name, requirement]) => [
          name,
          { requirement, editable: true },
        ]),
      ),
      notes: {
        campaignTypes,
        campaignTypeFields: CAMPAIGN_TYPE_FIELDS,
        officialLinks:
          "Each official link needs a public, verified fact stating its exact URL (factId).",
      },
    };
  },
  async validate(tx, scope, changes) {
    await merged(tx, scope, changes);
  },
  async apply(tx, scope, changes) {
    const { row, profile } = await merged(tx, scope, changes);
    await saveMarketingProfile(tx, scope, profile, row?.version ?? 0);
  },
};
