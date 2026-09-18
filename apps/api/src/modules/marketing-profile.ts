import type { DbTx } from "../../../../packages/db/src/index.ts";
import { marketingProfile } from "../../../../packages/schemas/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { data, entity, list, update, audit, DomainError } from "../shared.ts";
import { invalidateContent } from "./content-invalidation.ts";

export type MarketingProfile = ReturnType<typeof marketingProfile.parse>;

function owner(scope: Scope) {
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
}

export async function currentMarketingProfile(tx: DbTx, scope: Scope) {
  return tx.projectMarketingProfile.findFirst({
    where: { workspaceId: scope.workspaceId, projectId: scope.projectId },
  });
}

async function assertProfileReferences(
  tx: DbTx,
  scope: Scope,
  profile: MarketingProfile,
) {
  const links = new Set<string>();
  for (const link of profile.officialLinks) {
    if (links.has(link.url))
      throw new DomainError("DUPLICATE_OFFICIAL_LINK", 409);
    links.add(link.url);
    const fact = await entity(tx, scope, "facts", link.factId);
    const f = data(fact);
    if (f.status !== "verified" || f.publicUse === false)
      throw new DomainError("OFFICIAL_LINK_FACT_NOT_PUBLIC_VERIFIED", 409);
    const value = String(f.value?.amount ?? f.value ?? "");
    if (value !== link.url)
      throw new DomainError("OFFICIAL_LINK_FACT_VALUE_MISMATCH", 409);
  }
}

export async function saveMarketingProfile(
  tx: DbTx,
  scope: Scope,
  raw: unknown,
) {
  owner(scope);
  const profile = marketingProfile.parse(raw);
  await assertProfileReferences(tx, scope, profile);
  const existing = await currentMarketingProfile(tx, scope);
  const version = (existing?.version ?? 0) + 1;
  const saved = existing
    ? await tx.projectMarketingProfile.update({
        where: { id: existing.id },
        data: { version, data: profile },
      })
    : await tx.projectMarketingProfile.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          version,
          data: profile,
        },
      });
  await tx.projectMarketingProfileVersion.create({
    data: {
      profileId: saved.id,
      version,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      data: profile,
    },
  });
  if (existing)
    for (const content of await list(tx, scope, "content")) {
      const c = data(content);
      if (c.profileVersion !== existing.version) continue;
      await update(tx, scope, content, {
        ...c,
        status: "needs_review",
        profileInvalidatedFrom: existing.version,
        profileInvalidatedTo: version,
      });
      await invalidateContent(tx, scope, content.id);
    }
  await audit(tx, scope, "marketing_profile.save", saved.id, { version });
  return saved;
}

export async function assertCampaignContext(
  tx: DbTx,
  scope: Scope,
  input: Record<string, unknown>,
) {
  const profile = await currentMarketingProfile(tx, scope);
  if (!profile) throw new DomainError("MARKETING_PROFILE_REQUIRED", 409);
  if (input.profileVersion !== profile.version)
    throw new DomainError("MARKETING_PROFILE_VERSION_REQUIRED", 409);
  if (input.campaignType !== "product" && input.campaignType !== "presale")
    throw new DomainError("CAMPAIGN_TYPE_REQUIRED", 409);
  const profileData = marketingProfile.parse(profile.data);
  if (
    typeof input.targetAction === "string" &&
    !profileData.primaryCtas.includes(input.targetAction)
  )
    throw new DomainError("CAMPAIGN_PRIMARY_CTA_NOT_APPROVED", 409);
  return profile;
}

export async function assertContentCampaignContext(
  tx: DbTx,
  scope: Scope,
  input: Record<string, any>,
) {
  if (!input.missionId) throw new DomainError("CAMPAIGN_MISSION_REQUIRED", 409);
  const mission = await entity(tx, scope, "missions", input.missionId);
  const m = data(mission);
  const profile = await assertCampaignContext(tx, scope, {
    campaignType: input.campaignType ?? m.campaignType,
    profileVersion: input.profileVersion ?? m.profileVersion,
  });
  if (
    input.campaignType !== m.campaignType ||
    input.profileVersion !== m.profileVersion
  )
    throw new DomainError("CONTENT_CAMPAIGN_CONTEXT_MISMATCH", 409);
  if (!m.channels.includes(input.channel) || m.contentType !== input.type)
    throw new DomainError("MISSION_SCOPE_NOT_ALLOWED", 409);
  const profileData = marketingProfile.parse(profile.data);
  const allowedLinks = new Set(profileData.officialLinks.map((x) => x.url));
  if (input.targetUrl && !allowedLinks.has(input.targetUrl))
    throw new DomainError("TARGET_URL_NOT_OFFICIAL", 409);
  if (input.assetId) {
    const asset = data(await entity(tx, scope, "assets", input.assetId));
    if (asset.usageApproved !== true || asset.assetStatus !== "approved")
      throw new DomainError("ASSET_NOT_APPROVED", 409);
  }
  return { mission, profile, profileData };
}

const prohibited = [
  /\bguaranteed profit\b/i,
  /\brisk[- ]free\b/i,
  /\bguaranteed returns?\b/i,
  /\b(?:100x|moon|last chance|act now|limited time)\b/i,
];

export async function profileGuardrailProblems(
  tx: DbTx,
  scope: Scope,
  content: Record<string, any>,
) {
  const problems: string[] = [];
  // Historical deterministic fixtures are preserved read-only. New human and
  // campaign-generated content must have an explicit campaign context.
  if (
    content.synthetic === true &&
    (!content.missionId || !content.campaignType || !content.profileVersion)
  )
    return problems;
  let context: Awaited<ReturnType<typeof assertContentCampaignContext>>;
  try {
    context = await assertContentCampaignContext(tx, scope, content);
  } catch (error) {
    if (error instanceof DomainError) return [error.message];
    throw error;
  }
  const body = String(content.body ?? "");
  if (prohibited.some((pattern) => pattern.test(body)))
    problems.push("PROFILE_GUARDRAIL_PROHIBITED_LANGUAGE");
  const ctas = context.profileData.primaryCtas.filter((cta) =>
    body.toLocaleLowerCase().includes(cta.toLocaleLowerCase()),
  );
  if (ctas.length !== 1)
    problems.push(
      ctas.length > 1 ? "MULTIPLE_PRIMARY_CTAS" : "PRIMARY_CTA_REQUIRED",
    );
  if (/\b(?:is|status:)\s*(?:live|launched|released|coming soon)\b/i.test(body))
    problems.push("UNSUPPORTED_FEATURE_STATUS_VOCABULARY");
  if (
    /(?:€|\$|\b(?:USD|EUR)\b)\s?\d/.test(body) &&
    !(content.claims ?? []).some((claim: any) => claim.kind === "fact")
  )
    problems.push("UNSUPPORTED_PRICE_CLAIM");
  if (
    content.campaignType === "presale" &&
    /\bpresale\s+is\s+live\b/i.test(body)
  ) {
    const facts = await list(tx, scope, "facts");
    const confirmed = facts.some((fact) => {
      const f = data(fact);
      return (
        f.status === "verified" &&
        f.publicUse !== false &&
        /presale.*status/i.test(String(f.key)) &&
        String(f.value?.amount ?? f.value).toLowerCase() === "live"
      );
    });
    if (!confirmed) problems.push("PRESALE_LIVE_NOT_VERIFIED");
  }
  return problems;
}
