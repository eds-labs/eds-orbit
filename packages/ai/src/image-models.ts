import type { z } from "zod";
import type { imageModelSchema } from "./index.ts";

/** Source sizes the image API accepts (width x height in pixels). */
export const IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

type ImageModel = z.infer<typeof imageModelSchema>;

/** What an image model can do; callers pick sizes and options from here instead of hard-coding them. */
export type ImageModelCapabilities = {
  provider: "openai";
  sizes: readonly ImageSize[];
  transparentBackground: boolean;
  maxReferences: number;
  edit: boolean;
};

const GPT_IMAGE: ImageModelCapabilities = Object.freeze({
  provider: "openai",
  sizes: IMAGE_SIZES,
  transparentBackground: true,
  maxReferences: 16,
  edit: true,
});

/** Capabilities of every image model Orbit may call. */
export const IMAGE_MODELS: Readonly<
  Record<ImageModel, ImageModelCapabilities>
> = Object.freeze({
  "gpt-image-2.5-flare": GPT_IMAGE,
  "gpt-image-2.5-flare-2026-09-08": GPT_IMAGE,
  "gpt-image-2.5-sunburst": GPT_IMAGE,
  "gpt-image-2.5-sunburst-2026-09-08": GPT_IMAGE,
});

function aspectOf(size: ImageSize): number {
  const [width, height] = size.split("x").map(Number) as [number, number];
  return width / height;
}

/**
 * The model's source size whose aspect ratio is closest (in log terms, so
 * 2:1 and 1:2 are equally far from 1:1) to the target's width / height.
 */
export function sourceSizeFor(
  model: ImageModel,
  targetAspect: number,
): ImageSize {
  const sizes = IMAGE_MODELS[model].sizes;
  let best = sizes[0] as ImageSize;
  let bestDistance = Infinity;
  for (const size of sizes) {
    const distance = Math.abs(Math.log(aspectOf(size) / targetAspect));
    if (distance < bestDistance) {
      best = size;
      bestDistance = distance;
    }
  }
  return best;
}
