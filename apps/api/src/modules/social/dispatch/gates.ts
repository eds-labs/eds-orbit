import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import { liveSending } from "../../../platform/email/connection.ts";
import type { SocialPlatform } from "../accounts/store.ts";
import { publicMediaEnabled } from "../media/public-url.ts";
import type { ValidationContext } from "../posts/validation.ts";

// When the social module really posts (ADR 0020 §6.1, S5). Live mode needs
// EXECUTION_MODE=live and ENABLE_EXTERNAL_WRITES=true; otherwise every
// publication is a test publication without a provider call. A live send
// also needs the platform in ORBIT_SOCIAL_PLATFORMS and an adapter for it.

export type SendMode = "live" | "test";

/** The platforms Orbit can send to. */
export const SENDABLE_PLATFORMS: readonly SocialPlatform[] = ["x", "facebook", "instagram", "telegram"];

export const sendMode = (): SendMode => (liveSending() ? "live" : "test");

/** True when the installation switched the platform on and it has an adapter. */
export function platformEnabled(platform: SocialPlatform): boolean {
  const listed = loadConfig()
    .ORBIT_SOCIAL_PLATFORMS.split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return SENDABLE_PLATFORMS.includes(platform) && listed.includes(platform);
}

/** What validation needs to know about sending to a platform now. */
export const validationContext = (platform: SocialPlatform): ValidationContext => ({
  mode: sendMode(),
  platformEnabled: platformEnabled(platform),
  publicMedia: publicMediaEnabled(),
});
