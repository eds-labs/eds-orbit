import { randomUUID } from "node:crypto";
import { marketingProfile } from "../../../../packages/schemas/src/index.ts";

/**
 * A marketing profile of the fictional demo brand "Lumora Home" with a brand
 * kit, for creative studio tests. `identity` replaces fields of the visual
 * identity, `profile` fields of the profile.
 */
export function lumoraProfile(
  identity: Record<string, unknown> = {},
  profile: Record<string, unknown> = {},
) {
  return marketingProfile.parse({
    productName: "Lumora Home",
    contentLanguage: "en",
    internalLanguage: "en",
    audience: "Households that want a calmer, tidier home",
    positioning:
      "Warm, well made home goods that make everyday routines easier",
    productStrategy: "Show everyday moments, never promises",
    voice: ["warm", "plain"],
    guardrails: ["No unsupported claims"],
    primaryCtas: ["Shop the collection"],
    channelPriority: ["instagram"],
    notificationPreference: "none",
    officialLinks: [
      {
        label: "Shop",
        url: "https://example.invalid/shop",
        factId: randomUUID(),
      },
    ],
    assetPolicy: "approved_only",
    visualIdentity: {
      primaryColor: "#E8604C",
      secondaryColor: "#8C3B2C",
      accentColor: "#F6B26B",
      backgroundColor: "#FFF4E8",
      surfaceColor: "#FFFFFF",
      textColor: "#2B1B17",
      headingFont: "Inter",
      bodyFont: "Inter",
      designRules: ["Preserve the approved logo unchanged."],
      imagery: {
        kind: "photo",
        mood: "warm, calm, optimistic",
        subjects: "Bright living rooms, ceramics, linen and wood",
        avoid: ["Stock handshake photos", "Cold blue office light"],
      },
      forbiddenDesigns: ["Polaroid frames"],
      ...identity,
    },
    ...profile,
  });
}
