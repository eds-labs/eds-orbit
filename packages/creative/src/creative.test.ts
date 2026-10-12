import { describe, expect, it } from "vitest";
import {
  bannerTemplates,
  bannerTextOverflow,
  renderBrandBanner,
  renderRasterBanner,
  renderTemplate,
  renderRasterTemplate,
  templateFormats,
} from "./index.ts";
describe("deterministic original-brand renderer", () => {
  it.each(Object.keys(templateFormats) as (keyof typeof templateFormats)[])(
    "renders %s with expected size, unchanged logo and safe margin",
    (format) => {
      const input = {
        format,
        logoApproved: true,
        title: "Plan with evidence",
        subtitle: "Review every source before publishing.",
        cta: "Explore the workspace",
      };
      const a = renderTemplate(input),
        b = renderTemplate(input);
      expect(a.status).toBe("rendered");
      if (a.status !== "rendered") return;
      expect(a.contentHash).toBe(b.status === "rendered" ? b.contentHash : "");
      expect([a.width, a.height]).toEqual(templateFormats[format]);
      expect(a.logoHash).toBe(
        "a652f47968922890004e279004986a01ec968ffead1f3fb1a70af5c3e37f423c",
      );
      expect(a.svg).toContain("data:image/svg+xml;base64,");
      expect(a.safeMargin).toBeGreaterThan(80);
    },
  );
  it("blocks overflow instead of truncating or exporting clipped text", () => {
    expect(() =>
      renderTemplate({
        format: "landscape",
        logoApproved: true,
        title: "Extremely long title ".repeat(20),
      }),
    ).toThrow("TEXT_OVERFLOW");
  });
  it("escapes script and produces a brief when the source logo is unapproved", () => {
    const rendered = renderTemplate({
      format: "square",
      logoApproved: true,
      title: "<script> bad </script>",
    });
    expect(rendered.status === "rendered" && rendered.svg).not.toContain(
      "<script>",
    );
    expect(
      renderTemplate({ format: "square", title: "Hello", logoApproved: false }),
    ).toMatchObject({
      status: "blocked_asset",
      creativeBrief: { requiredAsset: "Approved original project logo" },
    });
  });
  it("renders only validated local brand tokens and approved raster artwork", async () => {
    const artwork = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1i8AAAAASUVORK5CYII=",
      "base64",
    );
    const rendered = renderTemplate({
      format: "square",
      logoApproved: true,
      title: "Brand-safe artwork",
      palette: {
        primaryColor: "#112233",
        secondaryColor: "#334455",
        accentColor: "#55AAFF",
        backgroundColor: "#F0F4F8",
        surfaceColor: "#FFFFFF",
        textColor: "#101820",
        headingFont: "Inter",
        bodyFont: "Arial",
      },
      visualDataUri: `data:image/png;base64,${artwork.toString("base64")}`,
      visualHash: "a".repeat(64),
    });
    expect(rendered.status).toBe("rendered");
    if (rendered.status !== "rendered") return;
    expect(rendered.svg).toContain("#F0F4F8");
    expect(rendered.svg).toContain("#101820");
    expect(rendered.svg).toContain("data:image/png;base64,");
    expect(rendered.visualHash).toBe("a".repeat(64));
  });
});

describe("bounded PNG export", () => {
  it("fails closed for omitted brand approval before rasterization", async () => {
    expect(renderTemplate({ format: "square", title: "Hello" })).toMatchObject({
      status: "blocked_asset",
    });
    expect(
      await renderRasterTemplate({ format: "square", title: "Hello" }),
    ).toMatchObject({ status: "blocked_asset" });
  });
  it.each(Object.keys(templateFormats) as (keyof typeof templateFormats)[])(
    "exports real PNG pixels for %s",
    async (format) => {
      const output = await renderRasterTemplate({
        format,
        title: "Evidence first",
        logoApproved: true,
      });
      expect(output.status).toBe("rendered");
      if (output.status !== "rendered") return;
      expect(output.mime).toBe("image/png");
      expect(output.bytes.subarray(0, 8).toString("hex")).toBe(
        "89504e470d0a1a0a",
      );
      expect([
        output.bytes.readUInt32BE(16),
        output.bytes.readUInt32BE(20),
      ]).toEqual(templateFormats[format]);
      expect(output.bytes.length).toBeGreaterThan(1000);
      expect(output.sourceSvgHash).toHaveLength(64);
      expect(output.logoHash).toBe(
        "a652f47968922890004e279004986a01ec968ffead1f3fb1a70af5c3e37f423c",
      );
      expect(output.renderer.version).toBe("0.35.5");
    },
  );
});

describe("brand banner (R78)", () => {
  const text = {
    headline1: "Start free.",
    headline2: "Build your workflow.",
    subline: "Markets. Paper trading. Bots.",
    button: "Explore Desk",
  };
  // A 1×1 PNG stands in for the model's background art.
  const background = `data:image/png;base64,${Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1i8AAAAASUVORK5CYII=",
    "base64",
  ).toString("base64")}`;
  const input = {
    template: "brand_landscape" as const,
    text,
    brandName: "uLiquid Desk",
    footer: "desk.uliquid.vip",
    logoApproved: true,
    backgroundDataUri: background,
    backgroundHash: "b".repeat(64),
  };
  /** The SVG's structure: element names with the attributes that place layers, no pixel data. */
  const structure = (svg: string) =>
    [...svg.matchAll(/<(image|text|tspan|rect|line|path)\b([^>]*)>/g)].map(
      ([, tag, attributes]) => {
        const id = attributes!.match(/\bdata-layer="([^"]+)"/)?.[1];
        return id ? `${tag}#${id}` : tag;
      },
    );

  it("adds a 16:9 format of 1600×900", () => {
    expect(templateFormats.wide).toEqual([1600, 900]);
    expect(bannerTemplates.brand_landscape).toEqual([1600, 900]);
  });

  it("composes background, left shade, approved logo, wordmark, headline, subline, button and footer", () => {
    const a = renderBrandBanner(input);
    const b = renderBrandBanner(input);
    expect(a.status).toBe("rendered");
    if (a.status !== "rendered") return;
    expect(a.contentHash).toBe(b.status === "rendered" ? b.contentHash : "");
    expect([a.width, a.height]).toEqual([1600, 900]);
    // The bundled logo stands in when no logo asset is given, unchanged.
    expect(a.logoHash).toBe(
      "a652f47968922890004e279004986a01ec968ffead1f3fb1a70af5c3e37f423c",
    );
    expect(a.backgroundHash).toBe("b".repeat(64));
    expect(structure(a.svg).filter((entry) => entry.includes("#")))
      .toMatchInlineSnapshot(`
      [
        "rect#base",
        "image#background",
        "rect#glow",
        "rect#shade",
        "image#logo",
        "text#wordmark",
        "text#headline1",
        "text#headline2",
        "text#subline",
        "rect#button",
        "text#button-label",
        "path#button-arrow",
        "line#divider",
        "text#footer",
        "rect#card",
        "image#card-logo",
      ]
    `);
    // Exact copy, shown in capitals; line 1 white, line 2 cyan.
    expect(a.svg).toContain(">START FREE.</tspan>");
    expect(a.svg).toContain("BUILD YOUR");
    expect(a.svg).toContain("WORKFLOW.");
    expect(a.svg).toContain(">Markets. Paper trading. Bots.</tspan>");
    expect(a.svg).toContain(">Explore Desk</text>");
    expect(a.svg).toContain(">desk.uliquid.vip</text>");
    expect(a.svg).toMatch(
      /><tspan>uLiquid<\/tspan><tspan dx="\d+" fill="#22D3EE">Desk</,
    );
    expect(a.svg).toContain(background);
    expect(a.lines).toEqual({
      headline1: ["START FREE."],
      headline2: ["BUILD YOUR", "WORKFLOW."],
      subline: ["Markets. Paper trading. Bots."],
    });
  });

  it("renders without a background on the template's own navy and waves", () => {
    const rendered = renderBrandBanner({
      ...input,
      backgroundDataUri: undefined,
      backgroundHash: undefined,
    });
    expect(rendered.status).toBe("rendered");
    if (rendered.status !== "rendered") return;
    expect(structure(rendered.svg)).not.toContain("image#background");
    expect(structure(rendered.svg)).toContain("path#wave");
  });

  it("blocks overflow instead of cutting text", () => {
    for (const changes of [
      { headline1: "Supercalifragilisticexpialidocious" },
      { headline2: "Build your workflow and your strategy today" },
      {
        subline:
          "Markets, paper trading, bots, alerts, journals, screeners and much more for every team.",
      },
      { button: "Explore the whole trading desk right now for free" },
    ]) {
      expect(() =>
        renderBrandBanner({ ...input, text: { ...text, ...changes } }),
      ).toThrow("TEXT_OVERFLOW");
      expect(bannerTextOverflow({ ...text, ...changes })).toBe(true);
    }
    expect(bannerTextOverflow(text)).toBe(false);
    expect(() =>
      renderBrandBanner({
        ...input,
        footer: "a-very-long-subdomain.example-domain-name.invalid",
      }),
    ).toThrow("TEXT_OVERFLOW");
  });

  it("keeps the logo rules: approval required, raster logos only, markup escaped", () => {
    expect(renderBrandBanner({ ...input, logoApproved: false })).toMatchObject({
      status: "blocked_asset",
      creativeBrief: { requiredAsset: "Approved original project logo" },
    });
    expect(() =>
      renderBrandBanner({
        ...input,
        logoDataUri: "data:image/svg+xml;base64,PHN2Zy8+",
      }),
    ).toThrow("INVALID_BRAND_ASSET");
    expect(() =>
      renderBrandBanner({
        ...input,
        backgroundDataUri: "https://example.invalid/a.png",
      }),
    ).toThrow("INVALID_BRAND_ASSET");
    const escaped = renderBrandBanner({
      ...input,
      text: { ...text, headline1: "<script>" },
    });
    expect(escaped.status === "rendered" && escaped.svg).not.toContain(
      "<script>",
    );
    expect(() =>
      renderBrandBanner({ ...input, text: { ...text, button: " " } }),
    ).toThrow("INVALID_TEMPLATE_INPUT");
  });

  it("exports a 1600×900 PNG", async () => {
    const output = await renderRasterBanner(input);
    expect(output.status).toBe("rendered");
    if (output.status !== "rendered") return;
    expect(output.mime).toBe("image/png");
    expect(output.bytes.subarray(0, 8).toString("hex")).toBe(
      "89504e470d0a1a0a",
    );
    expect([
      output.bytes.readUInt32BE(16),
      output.bytes.readUInt32BE(20),
    ]).toEqual([1600, 900]);
    expect(output.sourceSvgHash).toHaveLength(64);
  });
});
