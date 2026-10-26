import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import {
  CREATIVE_TEMPLATE_IDS,
  LOGO_ROLES,
  type CreativeBrand,
  type CreativeLogo,
  type FormatId,
  type LogoPlacement,
  type LogoRole,
  type TemplateId,
  type VariantId,
} from "../../../../../../packages/creative/src/index.ts";
import {
  marketingProfile,
  type Scope,
} from "../../../../../../packages/schemas/src/index.ts";
import { data, DomainError, type entity } from "../../../shared.ts";
import {
  currentMarketingProfile,
  type MarketingProfile,
} from "../brand/marketing-profile.ts";
import { assetContent } from "./asset-content.ts";

/** An `Entity` row as the database returns it. */
export type EntityRow = Awaited<ReturnType<typeof entity>>;

/** The project's creative settings with their defaults filled in. */
export type ResolvedCreativeConfig = {
  enabledTemplates: TemplateId[];
  defaultVariants: Partial<Record<TemplateId, VariantId>>;
  formatsByChannel: Record<string, FormatId[]>;
  logoPlacement: LogoPlacement;
  ctaStyle: "pill" | "outline" | "none";
  maxArtCorrections: 0 | 1 | 2;
  visualReview: boolean;
};

/**
 * The creative settings of a profile: every template enabled without a
 * default variant, automatic logo placement, pill CTA, one art correction and
 * no vision review unless the brand kit says otherwise.
 */
export function resolveCreativeConfig(
  profile: MarketingProfile,
): ResolvedCreativeConfig {
  const creative = profile.visualIdentity.creative;
  const templates = creative?.templates ?? {};
  const defaultVariants: ResolvedCreativeConfig["defaultVariants"] = {};
  for (const id of CREATIVE_TEMPLATE_IDS) {
    const variant = templates[id]?.variant;
    if (variant) defaultVariants[id] = variant;
  }
  return {
    enabledTemplates: CREATIVE_TEMPLATE_IDS.filter(
      (id) => templates[id]?.enabled !== false,
    ),
    defaultVariants,
    formatsByChannel: Object.fromEntries(
      Object.entries(creative?.formatsByChannel ?? {}).map(([channel, ids]) => [
        channel,
        [...ids],
      ]),
    ),
    logoPlacement: creative?.logoPlacement ?? "auto",
    ctaStyle: creative?.ctaStyle ?? "pill",
    maxArtCorrections: creative?.maxArtCorrections ?? 1,
    visualReview: creative?.visualReview ?? false,
  };
}

/** What a creative may be made of, read in one transaction. */
export type BrandKitPlan = {
  profileId: string;
  profileVersion: number;
  profile: MarketingProfile;
  /** Approved logo assets by role; `primary` is always there. */
  logos: Partial<Record<LogoRole, EntityRow>>;
  /** Approved screenshots, product images and photos of the brand kit. */
  products: EntityRow[];
  config: ResolvedCreativeConfig;
};

const RASTER_MIMES = ["image/png", "image/jpeg", "image/webp"];
/** Asset types a brand kit's product images may have (as `assertProfileReferences` allows). */
const PRODUCT_TYPES = ["screenshot", "product", "photo"];
const approved = (asset: Record<string, any>) =>
  asset.usageApproved === true && asset.assetStatus === "approved";

const findAsset = (tx: DbTx, scope: Scope, id: string) =>
  tx.entity.findFirst({
    where: {
      id,
      kind: "assets",
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
    },
  });

/**
 * Reads the current profile and the approved assets of its brand kit. The
 * logos are drawn from their exact bytes, so each must be an approved raster
 * `logo` with a stored SHA-256 (`APPROVED_LOGO_ASSET_REQUIRED`); the profile
 * needs a primary logo (`PRIMARY_LOGO_REQUIRED`) and itself
 * (`MARKETING_PROFILE_REQUIRED`). A product image that is no longer
 * approved is left out, so a creative never shows it.
 */
export async function resolveBrandKit(
  tx: DbTx,
  scope: Scope,
): Promise<BrandKitPlan> {
  const row = await currentMarketingProfile(tx, scope);
  if (!row) throw new DomainError("MARKETING_PROFILE_REQUIRED", 409);
  const profile = marketingProfile.parse(row.data);
  const identity = profile.visualIdentity;
  if (!identity.logoAssetId)
    throw new DomainError("PRIMARY_LOGO_REQUIRED", 409);

  const references: Array<[LogoRole, string]> = [
    ["primary", identity.logoAssetId],
  ];
  for (const role of LOGO_ROLES) {
    const id = role === "primary" ? undefined : identity.logos?.[role];
    if (id) references.push([role, id]);
  }
  const rows = new Map<string, EntityRow | null>();
  const load = async (id: string) => {
    if (!rows.has(id)) rows.set(id, await findAsset(tx, scope, id));
    return rows.get(id) ?? null;
  };
  const logos: BrandKitPlan["logos"] = {};
  for (const [role, id] of references) {
    const logo = await load(id);
    const d = data(logo);
    if (
      !logo ||
      d.type !== "logo" ||
      !approved(d) ||
      !RASTER_MIMES.includes(d.mime) ||
      !/^[0-9a-f]{64}$/iu.test(String(d.sha256 ?? ""))
    )
      throw new DomainError("APPROVED_LOGO_ASSET_REQUIRED", 409);
    logos[role] = logo;
  }
  const products: EntityRow[] = [];
  for (const id of identity.productAssetIds ?? []) {
    const product = await load(id);
    const d = data(product);
    if (
      product &&
      PRODUCT_TYPES.includes(d.type) &&
      approved(d) &&
      RASTER_MIMES.includes(d.mime)
    )
      products.push(product);
  }
  return {
    profileId: row.id,
    profileVersion: row.version,
    profile,
    logos,
    products,
    config: resolveCreativeConfig(profile),
  };
}

/**
 * The brand as the layout engine takes it: palette, typography and the
 * logos' bytes, each checked against its approved SHA-256
 * (`BRAND_ASSET_INTEGRITY_FAILED`). Reads files (Drive), so it runs outside
 * any transaction.
 */
export async function loadCreativeBrand(
  scope: Scope,
  plan: BrandKitPlan,
): Promise<CreativeBrand> {
  const identity = plan.profile.visualIdentity;
  const logos = await Promise.all(
    (Object.entries(plan.logos) as Array<[LogoRole, EntityRow]>).map(
      async ([role, logo]): Promise<CreativeLogo> => {
        const stored = data(logo);
        const content = await assetContent(scope, stored);
        if (content.sha256 !== String(stored.sha256).toLowerCase())
          throw new DomainError("BRAND_ASSET_INTEGRITY_FAILED", 409);
        return { role, bytes: content.bytes, sha256: content.sha256 };
      },
    ),
  );
  return {
    brandName: plan.profile.productName,
    palette: {
      primaryColor: identity.primaryColor,
      secondaryColor: identity.secondaryColor,
      accentColor: identity.accentColor,
      backgroundColor: identity.backgroundColor,
      surfaceColor: identity.surfaceColor,
      textColor: identity.textColor,
      headingFont: identity.headingFont,
      bodyFont: identity.bodyFont,
    },
    typography: identity.typography ?? {
      headingWeight: 700,
      headingCase: "none",
    },
    logos,
    ctaStyle: plan.config.ctaStyle,
  };
}
