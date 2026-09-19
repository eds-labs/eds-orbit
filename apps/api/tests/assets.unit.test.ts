import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { renderRasterTemplate } from "../../../packages/creative/src/index.ts";
import { marketingProfile } from "../../../packages/schemas/src/index.ts";
import { normalizeBrandAsset } from "../src/modules/assets.ts";
import {
  buildBrandImagePrompt,
  imageGenerationInput,
} from "../src/modules/image-generation.ts";
import {
  openAiConfigurationInput,
  publicOpenAiConfiguration,
} from "../src/modules/openai-configuration.ts";
import { publicEntity } from "../src/shared.ts";

const profile = marketingProfile.parse({
  productName: "Synthetic brand",
  contentLanguage: "en",
  internalLanguage: "de",
  audience: "Product teams",
  positioning: "Evidence-led publishing",
  productStrategy: "Explain the product",
  presaleStrategy: "Use verified facts only",
  voice: ["Clear"],
  guardrails: ["No unsupported claims"],
  primaryCtas: ["Learn more"],
  channelPriority: ["x"],
  notificationPreference: "none",
  officialLinks: [
    {
      label: "Website",
      url: "https://example.invalid",
      factId: randomUUID(),
    },
  ],
  visualIdentity: {
    primaryColor: "#112233",
    secondaryColor: "#334455",
    accentColor: "#55AAFF",
    backgroundColor: "#F0F4F8",
    surfaceColor: "#FFFFFF",
    textColor: "#101820",
    headingFont: "Inter",
    bodyFont: "Arial",
    designRules: ["Use clean geometric forms."],
  },
  assetPolicy: "approved_only",
});

describe("brand asset boundaries", () => {
  it("normalizes an uploaded raster, strips metadata, and starts outside approval", async () => {
    const rendered = await renderRasterTemplate({
      format: "square",
      logoApproved: true,
      title: "Synthetic fixture",
    });
    expect(rendered.status).toBe("rendered");
    if (rendered.status !== "rendered")
      throw new Error("FIXTURE_RENDER_FAILED");
    const input = rendered.bytes;
    const normalized = await normalizeBrandAsset({
      name: "Synthetic banner",
      type: "banner",
      mime: "image/png",
      base64: input.toString("base64"),
      source: "Synthetic unit fixture",
      license: "Synthetic rights fixture",
      validUses: ["social"],
      confirmRightsInformation: true,
    });

    expect(normalized).toMatchObject({
      mime: "image/png",
      width: 1080,
      height: 1080,
      metadataStripped: true,
      rightsInformationConfirmed: true,
    });
    expect(normalized.sha256).toHaveLength(64);
    expect(
      Buffer.from(normalized.base64, "base64").subarray(0, 8).toString("hex"),
    ).toBe("89504e470d0a1a0a");
  });

  it("rejects a declared MIME type that does not match the bytes", async () => {
    const rendered = await renderRasterTemplate({
      format: "square",
      logoApproved: true,
      title: "Synthetic fixture",
    });
    expect(rendered.status).toBe("rendered");
    if (rendered.status !== "rendered")
      throw new Error("FIXTURE_RENDER_FAILED");

    await expect(
      normalizeBrandAsset({
        name: "Spoofed image",
        type: "photo",
        mime: "image/jpeg",
        base64: rendered.bytes.toString("base64"),
        source: "Synthetic unit fixture",
        license: "Synthetic rights fixture",
        validUses: ["blog"],
        confirmRightsInformation: true,
      }),
    ).rejects.toThrow("ASSET_IMAGE_INVALID");
  });

  it("never exposes stored image bytes in an entity response", () => {
    const safe = publicEntity({
      id: randomUUID(),
      kind: "assets",
      data: { base64: "c2VjcmV0LWJ5dGVz", mime: "image/png" },
    });
    expect(safe.data).toMatchObject({ mime: "image/png", hasContent: true });
    expect(safe.data).not.toHaveProperty("base64");
  });
});

describe("OpenAI image generation gates", () => {
  it("requires an allowlisted image model and a verified non-zero cost ceiling", () => {
    const pricingVerifiedAt = new Date().toISOString();
    const accepted = openAiConfigurationInput.parse({
      verifiedModels: [
        "gpt-5.6-luna",
        "gpt-5.6-terra",
        "gpt-5.6-sol",
        "gpt-image-2.5-flare",
      ],
      rateCard: {},
      imageGeneration: {
        model: "gpt-image-2.5-flare",
        maxCostMicrosPerImage: 250_000,
        pricingVerifiedAt,
      },
    });
    expect(accepted.imageGeneration.model).toBe("gpt-image-2.5-flare");
    expect(() =>
      openAiConfigurationInput.parse({
        verifiedModels: [],
        rateCard: {},
        imageGeneration: {
          model: "gpt-image-2.5-flare",
          maxCostMicrosPerImage: 250_000,
          pricingVerifiedAt,
        },
      }),
    ).toThrow("IMAGE_MODEL_NOT_VERIFIED");
  });

  it("reports a dedicated image key without returning encrypted key material", () => {
    const view = publicOpenAiConfiguration({
      version: 3,
      data: {
        encryptedApiKey: "shared-opaque-ciphertext",
        encryptedImageApiKey: "image-opaque-ciphertext",
        verifiedModels: ["gpt-image-2.5-flare"],
        rateCard: {},
        modelRoutes: {
          fast: "gpt-5.6-luna",
          standard: "gpt-5.6-terra",
          quality: "gpt-5.6-sol",
          escalation: "gpt-6-astra",
        },
        imageGeneration: {
          model: "gpt-image-2.5-flare",
          maxCostMicrosPerImage: 0,
        },
        updatedBy: randomUUID(),
        updatedAt: new Date().toISOString(),
      },
    });
    expect(view).toMatchObject({
      configured: true,
      textKeyConfigured: true,
      imageKeyConfigured: true,
      dedicatedImageKeyConfigured: true,
    });
    expect(JSON.stringify(view)).not.toContain("opaque-ciphertext");
  });

  it("requires explicit prompt transmission and exact maximum-cost confirmation", () => {
    const base = {
      requestId: randomUUID(),
      name: "Synthetic artwork",
      prompt: "An abstract blue research workspace with clear negative space",
      size: "1024x1024" as const,
      quality: "medium" as const,
      background: "opaque" as const,
      validUses: ["social" as const],
      confirmMaximumCostMicros: 250_000,
    };
    expect(() => imageGenerationInput.parse(base)).toThrow();
    expect(
      imageGenerationInput.parse({
        ...base,
        confirmPromptMayBeSentToOpenAI: true,
      }),
    ).toMatchObject({ confirmMaximumCostMicros: 250_000 });
  });

  it("builds a brand-bounded prompt without requesting generated logos or copy", () => {
    const prompt = buildBrandImagePrompt(
      "A calm product launch visual",
      profile,
    );
    expect(prompt).toContain("primary #112233");
    expect(prompt).toContain(
      "Do not create, imitate, redraw, or alter any logo",
    );
    expect(prompt).toContain("Leave clean negative space");
    expect(prompt).toContain("A calm product launch visual");
  });
});
