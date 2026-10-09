import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  edit: vi.fn(),
  generate: vi.fn(),
  toFile: vi.fn(async (bytes: Buffer, name: string, options: any) => ({
    name,
    type: options.type,
    size: bytes.length,
  })),
}));
vi.mock("openai", () => ({
  default: class {
    images = { edit: sdk.edit, generate: sdk.generate };
  },
  toFile: sdk.toFile,
}));
import { generateImageWithReferences } from "./index.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000", "hex");
const runtime = {
  apiKey: "test-key",
  verifiedModels: ["gpt-image-2.5-flare"],
  rateCard: {},
  imageGeneration: {
    model: "gpt-image-2.5-flare" as const,
    maxCostMicrosPerImage: 50_000,
    pricingVerifiedAt: new Date().toISOString(),
  },
};
const params = {
  prompt: "A calm abstract artwork.",
  size: "1024x1024" as const,
  quality: "medium" as const,
  background: "opaque" as const,
  reservationId: "r",
  runtime,
  user: "u",
  references: [
    { bytes: PNG, mime: "image/png" as const, filename: "banner.png" },
  ],
};

describe("image generation with style references", () => {
  beforeEach(() => {
    sdk.edit.mockReset().mockResolvedValue({
      data: [{ b64_json: PNG.toString("base64") }],
      size: "1024x1024",
      quality: "medium",
      background: "opaque",
    });
    sdk.generate.mockReset();
    sdk.toFile.mockClear();
  });

  it("sends the references to images.edit of the configured model and returns the PNG", async () => {
    const result = await generateImageWithReferences(params);
    expect(sdk.generate).not.toHaveBeenCalled();
    const body = sdk.edit.mock.calls[0]![0];
    expect(body).toMatchObject({
      model: "gpt-image-2.5-flare",
      prompt: "A calm abstract artwork.",
      output_format: "png",
      n: 1,
      image: [{ name: "banner.png", type: "image/png" }],
    });
    expect(result.bytes.equals(PNG)).toBe(true);
    expect(result.model).toBe("gpt-image-2.5-flare");
  });

  it("refuses without references, with too many or with an unsupported type", async () => {
    for (const references of [
      [],
      Array.from({ length: 17 }, () => params.references[0]!),
      [{ bytes: PNG, mime: "image/gif" as never, filename: "a.gif" }],
    ])
      await expect(
        generateImageWithReferences({ ...params, references }),
      ).rejects.toThrow("IMAGE_REFERENCES_INVALID");
    expect(sdk.edit).not.toHaveBeenCalled();
  });

  it("fails closed without a reservation or a verified model", async () => {
    await expect(
      generateImageWithReferences({ ...params, reservationId: "" }),
    ).rejects.toThrow("PAID_CALL_NOT_AUTHORIZED");
    await expect(
      generateImageWithReferences({
        ...params,
        runtime: { ...runtime, verifiedModels: [] },
      }),
    ).rejects.toThrow("IMAGE_MODEL_NOT_VERIFIED");
    expect(sdk.edit).not.toHaveBeenCalled();
  });

  it("rejects output that is not a PNG", async () => {
    sdk.edit.mockResolvedValue({
      data: [{ b64_json: Buffer.from("not a png").toString("base64") }],
    });
    await expect(generateImageWithReferences(params)).rejects.toThrow(
      "IMAGE_OUTPUT_INVALID",
    );
  });
});
