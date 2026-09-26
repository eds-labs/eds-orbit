import type { DbTx } from "../../../../packages/db/src/index.ts";
import { marketingProfile } from "../../../../packages/schemas/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { data, entity, list, update, audit, DomainError } from "../shared.ts";
import { invalidateContent } from "./content-invalidation.ts";
import { resolveChannelRules } from "./channel-rules.ts";
import { validateEvidence } from "../../../../packages/knowledge/src/index.ts";
import { factClaimMatches } from "./fact-claims.ts";

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
  if (profile.visualIdentity.logoAssetId) {
    const asset = data(
      await entity(tx, scope, "assets", profile.visualIdentity.logoAssetId),
    );
    if (
      !["logo", "original_logo"].includes(String(asset.type)) ||
      asset.usageApproved !== true ||
      asset.assetStatus !== "approved"
    )
      throw new DomainError("APPROVED_LOGO_ASSET_REQUIRED", 409);
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
  at = new Date(),
) {
  const profile = await currentMarketingProfile(tx, scope);
  if (!profile) throw new DomainError("MARKETING_PROFILE_REQUIRED", 409);
  if (input.profileVersion !== profile.version)
    throw new DomainError("MARKETING_PROFILE_VERSION_REQUIRED", 409);
  if (input.campaignType !== "product" && input.campaignType !== "presale")
    throw new DomainError("CAMPAIGN_TYPE_REQUIRED", 409);
  const profileData = marketingProfile.parse(profile.data);
  if (!profileData.primaryCtas.includes(String(input.targetAction ?? "")))
    throw new DomainError("CAMPAIGN_PRIMARY_CTA_NOT_APPROVED", 409);
  if (input.language !== profileData.contentLanguage)
    throw new DomainError("CAMPAIGN_LANGUAGE_NOT_APPROVED", 409);
  if (typeof input.targetUrl !== "string" || !input.targetUrl)
    throw new DomainError("CAMPAIGN_TARGET_URL_REQUIRED", 409);
  const link = profileData.officialLinks.find(
    (item) => item.url === input.targetUrl,
  );
  if (!link) throw new DomainError("TARGET_URL_NOT_OFFICIAL", 409);
  const fact = data(await entity(tx, scope, "facts", link.factId));
  if (
    fact.status !== "verified" ||
    fact.publicUse !== true ||
    Date.parse(fact.validFrom) > at.valueOf() ||
    (fact.validUntil && Date.parse(fact.validUntil) <= at.valueOf()) ||
    String(fact.value?.amount ?? fact.value ?? "") !== link.url
  )
    throw new DomainError("OFFICIAL_LINK_FACT_NOT_CURRENT", 409);
  const source = data(await entity(tx, scope, "sources", fact.sourceId));
  if (source.status !== "active" || source.publicUse !== true)
    throw new DomainError("OFFICIAL_LINK_SOURCE_NOT_APPROVED", 409);
  return profile;
}

export async function campaignGenerationContext(
  tx: DbTx,
  scope: Scope,
  mission: Record<string, any>,
  targetChannel: string,
  at = new Date(),
) {
  const profile = await assertCampaignContext(tx, scope, mission, at);
  const value = marketingProfile.parse(profile.data);
  const link = value.officialLinks.find(
    (item) => item.url === mission.targetUrl,
  )!;
  const linkFact = await entity(tx, scope, "facts", link.factId);
  const linkSource = data(
    await entity(tx, scope, "sources", data(linkFact).sourceId),
  );
  if (data(linkFact).modelUse !== true || linkSource.modelUse !== true)
    throw new DomainError("OFFICIAL_LINK_FACT_MODEL_USE_REQUIRED", 409);
  const channelRules = await resolveChannelRules(
    tx,
    scope,
    targetChannel,
    mission.contentType,
    !!mission.assetIds?.length,
  );
  return {
    projectId: scope.projectId,
    profileId: profile.id,
    profileVersion: profile.version,
    campaignType: mission.campaignType as "product" | "presale",
    product: value.productName,
    requestedProduct: mission.product ?? "",
    audience: mission.audience,
    profileAudience: value.audience,
    language: value.contentLanguage,
    targetChannel,
    channelProvider: channelRules.providerIdentifier,
    channelConnectorId: channelRules.connectorId,
    channelConnectorVersion: channelRules.connectorVersion,
    positioning: value.positioning,
    strategy:
      mission.campaignType === "presale"
        ? value.presaleStrategy
        : value.productStrategy,
    voice: value.voice,
    guardrails: value.guardrails,
    intendedPrimaryCta: mission.targetAction as string,
    officialTargetUrl: link.url,
    officialLinkFactId: link.factId,
    officialLinkFactVersion: linkFact.version,
  };
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
    targetAction: m.targetAction,
    targetUrl: m.targetUrl,
    language: m.language,
  });
  if (
    input.campaignType !== m.campaignType ||
    input.profileVersion !== m.profileVersion
  )
    throw new DomainError("CONTENT_CAMPAIGN_CONTEXT_MISMATCH", 409);
  if (!m.channels.includes(input.channel) || m.contentType !== input.type)
    throw new DomainError("MISSION_SCOPE_NOT_ALLOWED", 409);
  const profileData = marketingProfile.parse(profile.data);
  if (input.targetUrl !== m.targetUrl)
    throw new DomainError("CONTENT_TARGET_URL_MISMATCH", 409);
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

async function supportedFactClaims(
  tx: DbTx,
  scope: Scope,
  content: Record<string, any>,
  at: Date,
) {
  if (
    !content.evidenceId ||
    !(await validateEvidence(tx, scope, content.evidenceId, at)).valid
  )
    return [];
  const evidence = data(
    await entity(tx, scope, "evidence", content.evidenceId),
  );
  const supported: {
    claim: Record<string, any>;
    fact: Record<string, any>;
    source: Record<string, any>;
  }[] = [];
  for (const claim of content.claims ?? []) {
    if (
      claim.kind !== "fact" ||
      !claim.factId ||
      !content.body.includes(claim.text)
    )
      continue;
    const reference = (evidence.facts ?? []).find(
      (item: any) => item.id === claim.factId,
    );
    if (!reference) continue;
    try {
      const row = await entity(tx, scope, "facts", claim.factId);
      const fact = data(row);
      const source = data(await entity(tx, scope, "sources", fact.sourceId));
      if (
        row.version !== reference.version ||
        fact.status !== "verified" ||
        fact.publicUse !== true ||
        fact.sourceId !== reference.sourceId ||
        fact.sourceGeneration !== source.generation ||
        source.status !== "active" ||
        source.publicUse !== true ||
        source.authority === "generated" ||
        (source.embargoUntil &&
          Date.parse(source.embargoUntil) > at.valueOf()) ||
        !Number.isFinite(Date.parse(fact.validFrom)) ||
        Date.parse(fact.validFrom) > at.valueOf() ||
        (fact.validUntil && Date.parse(fact.validUntil) <= at.valueOf()) ||
        !factClaimMatches(claim.text, fact)
      )
        continue;
      supported.push({ claim, fact, source });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
    }
  }
  return supported;
}

const presaleLive =
  /\b(?:presale\s+(?:is\s+)?(?:(?:now|currently|officially)\s+)?live|(?:(?:now|currently|officially)\s+)?live\s+(?:(?:uliq|uliquid)(?:\s+desk)?\s+)?presale|presale[.\s]+status:\s*live)\b/gi;
const moneyMention =
  /(?:€|\$|\b(?:USD|EUR)\b)\s*\d+(?:[.,]\d+)?|\b\d+(?:[.,]\d+)?\s*(?:€|\$|\b(?:USD|EUR)\b)/giu;

function supportedPriceMention(
  mention: string,
  supported: Awaited<ReturnType<typeof supportedFactClaims>>,
) {
  const amount = mention.match(/\d+(?:[.,]\d+)?/u)?.[0];
  const currency = /€/u.test(mention)
    ? "EUR"
    : /\$/u.test(mention)
      ? "USD"
      : mention.match(/\b(?:USD|EUR)\b/iu)?.[0].toUpperCase();
  return (
    !!amount &&
    !!currency &&
    supported.some(
      ({ claim, fact }) =>
        claim.text.includes(mention) &&
        fact.valueType === "decimal" &&
        fact.currency === currency &&
        Number(String(fact.value)) === Number(amount.replace(",", ".")),
    )
  );
}

export async function profileGuardrailProblems(
  tx: DbTx,
  scope: Scope,
  content: Record<string, any>,
  at = new Date(),
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
  else if (ctas[0] !== data(context.mission).targetAction)
    problems.push("MISSION_PRIMARY_CTA_REQUIRED");
  const presaleStatements = [...body.matchAll(presaleLive)];
  const remainingStatusText = body.replace(presaleLive, "");
  if (
    /\b(?:is|status:)\s*(?:(?:now|currently|officially)\s+)?(?:live|launched|released|coming soon)\b/i.test(
      remainingStatusText,
    )
  )
    problems.push("UNSUPPORTED_FEATURE_STATUS_VOCABULARY");
  const prices = [...body.matchAll(moneyMention)];
  const supported =
    presaleStatements.length || prices.length
      ? await supportedFactClaims(tx, scope, content, at)
      : [];
  if (prices.some((match) => !supportedPriceMention(match[0], supported)))
    problems.push("UNSUPPORTED_PRICE_CLAIM");
  if (
    presaleStatements.length &&
    (content.campaignType !== "presale" ||
      !supported.some(({ claim, fact, source }) => {
        const key = String(fact.key)
          .toLocaleLowerCase()
          .split(/[^\p{L}\p{N}]+/u);
        const ageMs = at.valueOf() - Date.parse(fact.verifiedAt);
        const maxAgeMs = Math.min(Number(source.maxAgeHours), 24) * 3600000;
        return (
          key.includes("presale") &&
          key.includes("status") &&
          String(fact.value).toLocaleLowerCase() === "live" &&
          presaleStatements.some((statement) =>
            claim.text.includes(statement[0]),
          ) &&
          Number.isFinite(ageMs) &&
          ageMs >= 0 &&
          Number.isFinite(maxAgeMs) &&
          maxAgeMs > 0 &&
          ageMs < maxAgeMs
        );
      }))
  )
    problems.push("PRESALE_LIVE_NOT_VERIFIED");
  return problems;
}
