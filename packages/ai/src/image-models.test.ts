import { describe, expect, it } from "vitest";
import {
  IMAGE_MODELS,
  IMAGE_SIZES,
  imageModelSchema,
  sourceSizeFor,
} from "./index.ts";

describe("IMAGE_MODELS", () => {
  it("has capabilities for every image model the schema accepts", () => {
    for (const model of imageModelSchema.options) {
      expect(IMAGE_MODELS[model]).toBeDefined();
      expect(IMAGE_MODELS[model].provider).toBe("openai");
      expect(IMAGE_MODELS[model].sizes).toEqual(IMAGE_SIZES);
      expect(IMAGE_MODELS[model].transparentBackground).toBe(true);
      expect(IMAGE_MODELS[model].maxReferences).toBe(16);
      expect(IMAGE_MODELS[model].edit).toBe(true);
    }
    expect(Object.keys(IMAGE_MODELS).sort()).toEqual(
      [...imageModelSchema.options].sort(),
    );
  });
});

describe("sourceSizeFor", () => {
  it("picks the portrait source for portrait and story targets", () => {
    for (const model of imageModelSchema.options) {
      expect(sourceSizeFor(model, 1080 / 1350)).toBe("1024x1536");
      expect(sourceSizeFor(model, 1080 / 1920)).toBe("1024x1536");
    }
  });

  it("picks the landscape source for wide targets", () => {
    for (const model of imageModelSchema.options)
      expect(sourceSizeFor(model, 1200 / 630)).toBe("1536x1024");
  });

  it("picks the square source for square targets", () => {
    for (const model of imageModelSchema.options)
      expect(sourceSizeFor(model, 1)).toBe("1024x1024");
  });
});
