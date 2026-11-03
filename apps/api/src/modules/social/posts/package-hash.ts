import { hash } from "../../../shared.ts";

// What an approval binds (ADR 0020 §6.3, S-D6): every variant's account,
// text, options and images (by content hash, in order) and the time. The
// title is not part of it; neither is the account's health, which the
// dispatcher checks again before sending (S5).

export type SocialPackage = {
  postId: string;
  schedule: { mode: string; at: string | null };
  variants: Array<{
    accountId: string;
    platform: string;
    externalId: string;
    body: string;
    options: unknown;
    media: Array<{ position: number; sha256: string; altText: string | null }>;
  }>;
};

type PostRow = { id: string; scheduleMode: string; scheduledAt: Date | null };
type VariantRow = { id: string; accountId: string; body: string; platformOptions: unknown };
type MediaRow = { variantId: string; position: number; sha256: string; altText: string | null };
type AccountRow = { id: string; platform: string; externalId: string };

export function computePackage(
  post: PostRow,
  variants: VariantRow[],
  media: MediaRow[],
  accounts: AccountRow[],
): { hash: string; package: SocialPackage } {
  const accountOf = new Map(accounts.map((a) => [a.id, a]));
  const pkg: SocialPackage = {
    postId: post.id,
    schedule: { mode: post.scheduleMode, at: post.scheduledAt?.toISOString() ?? null },
    variants: [...variants]
      .sort((a, b) => a.accountId.localeCompare(b.accountId))
      .map((v) => {
        const account = accountOf.get(v.accountId);
        return {
          accountId: v.accountId,
          platform: account?.platform ?? "",
          externalId: account?.externalId ?? "",
          body: v.body,
          options: v.platformOptions ?? {},
          media: media
            .filter((m) => m.variantId === v.id)
            .sort((a, b) => a.position - b.position)
            .map((m) => ({ position: m.position, sha256: m.sha256, altText: m.altText })),
        };
      }),
  };
  return { hash: hash(pkg), package: pkg };
}
