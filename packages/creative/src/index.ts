import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const logo = readFileSync(
  new URL("../assets/logo-layer-stack-mark.svg", import.meta.url),
);
const logoHash = createHash("sha256").update(logo).digest("hex");
const manifest = JSON.parse(
  readFileSync(new URL("../assets/manifest.json", import.meta.url), "utf8"),
) as { sha256: string };
if (logoHash !== manifest.sha256)
  throw new Error("BRAND_ASSET_INTEGRITY_FAILED");
export const templateFormats = {
  square: [1080, 1080],
  landscape: [1200, 630],
  portrait: [1080, 1350],
  story: [1080, 1920],
} as const;
export type BrandPalette = {
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  backgroundColor: string;
  surfaceColor: string;
  textColor: string;
  headingFont: "Inter" | "DejaVu Sans" | "Arial" | "system-ui";
  bodyFont: "Inter" | "DejaVu Sans" | "Arial" | "system-ui";
};
export type TemplateInput = {
  format: keyof typeof templateFormats;
  title: string;
  subtitle?: string;
  cta?: string;
  brandName?: string;
  logoApproved?: boolean;
  logoDataUri?: string;
  logoHash?: string;
  visualDataUri?: string;
  visualHash?: string;
  palette?: BrandPalette;
};
export class CreativeError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "CreativeError";
  }
}
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const defaults: BrandPalette = {
  primaryColor: "#0969FF",
  secondaryColor: "#254D66",
  accentColor: "#45C2FF",
  backgroundColor: "#F6FBFF",
  surfaceColor: "#FFFFFF",
  textColor: "#071522",
  headingFont: "DejaVu Sans",
  bodyFont: "DejaVu Sans",
};
const color = (value: string) => {
  if (!/^#[0-9A-F]{6}$/i.test(value))
    throw new CreativeError("INVALID_BRAND_COLOR");
  return value.toUpperCase();
};
const font = (value: string) => {
  if (!["Inter", "DejaVu Sans", "Arial", "system-ui"].includes(value))
    throw new CreativeError("INVALID_BRAND_FONT");
  return value;
};
const dataImage = (value: string | undefined) => {
  if (
    value &&
    !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    throw new CreativeError("INVALID_BRAND_ASSET");
  return value;
};
function width(text: string, size: number) {
  return Array.from(text).reduce(
    (n, char) =>
      n +
      (/\s/u.test(char)
        ? 0.45
        : /[ilI.,'!|]/u.test(char)
          ? 0.4
          : /[MW@#%]/u.test(char)
            ? 1.1
            : (char.codePointAt(0) ?? 0) > 255
              ? 1.3
              : 0.85) *
        size,
    0,
  );
}
function wrap(text: string, maxWidth: number, size: number, maxLines: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.trim().split(/\s+/u)) {
    if (width(word, size) > maxWidth) throw new CreativeError("TEXT_OVERFLOW");
    const next = line ? line + " " + word : word;
    if (width(next, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) throw new CreativeError("TEXT_OVERFLOW");
  return lines;
}
/** Fixed, bounded template rendering; no generated logo or font download. */
export function renderTemplate(input: TemplateInput) {
  if (
    !Object.hasOwn(templateFormats, input.format) ||
    !input.title.trim() ||
    input.title.length > 500 ||
    (input.subtitle?.length ?? 0) > 500 ||
    (input.cta?.length ?? 0) > 80 ||
    (input.brandName?.length ?? 0) > 80 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(
      input.title +
        (input.subtitle ?? "") +
        (input.cta ?? "") +
        (input.brandName ?? ""),
    )
  )
    throw new CreativeError("INVALID_TEMPLATE_INPUT");
  if (input.logoApproved !== true)
    return {
      status: "blocked_asset" as const,
      creativeBrief: {
        format: input.format,
        title: input.title,
        subtitle: input.subtitle ?? "",
        requiredAsset: "Approved original project logo",
        nextStep: "Approve a source asset before rendering an export.",
      },
    };
  const palette = input.palette ?? defaults;
  const primary = color(palette.primaryColor),
    secondary = color(palette.secondaryColor),
    accent = color(palette.accentColor),
    background = color(palette.backgroundColor),
    surface = color(palette.surfaceColor),
    text = color(palette.textColor),
    headingFont = font(palette.headingFont),
    bodyFont = font(palette.bodyFont);
  const approvedLogo =
    dataImage(input.logoDataUri) ??
    `data:image/svg+xml;base64,${logo.toString("base64")}`;
  const visual = dataImage(input.visualDataUri);
  const [w, h] = templateFormats[input.format];
  const margin = Math.round(w * 0.08);
  const textWidth = w - 2 * margin;
  const landscape = input.format === "landscape";
  const titleSize = landscape ? 54 : 64;
  const bodySize = landscape ? 26 : 32;
  const titleLines = wrap(input.title, textWidth, titleSize, landscape ? 3 : 6);
  const bodyLines = input.subtitle?.trim()
    ? wrap(input.subtitle, textWidth, bodySize, landscape ? 2 : 4)
    : [];
  const cta = input.cta?.trim() ?? "";
  if (width(cta, 26) > textWidth - 48) throw new CreativeError("TEXT_OVERFLOW");
  const brand = input.brandName ?? "EDS Labs";
  if (width(brand, 25) > textWidth - 128)
    throw new CreativeError("TEXT_OVERFLOW");
  const titleY = landscape ? 240 : Math.round(h * 0.31);
  const titleHeight = titleLines.length * titleSize * 1.18;
  const bodyY = titleY + titleHeight + 24;
  const bodyBottom = bodyY + bodyLines.length * bodySize * 1.45;
  const ctaY = h - margin - 62;
  if (
    (bodyLines.length ? bodyBottom : titleY + titleHeight) >
    (cta ? ctaY - 32 : h - margin)
  )
    throw new CreativeError("TEXT_OVERFLOW");
  const textLines = (
    lines: string[],
    y: number,
    size: number,
    lineHeight: number,
    fill: string,
    weight: number,
    family: string,
  ) =>
    `<text x="${margin}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}" font-family="${escape(family)}, Arial, sans-serif">${lines.map((line, i) => `<tspan x="${margin}" dy="${i ? lineHeight : 0}">${escape(line)}</tspan>`).join("")}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="title desc"><title id="title">${escape(input.title)}</title><desc id="desc">${escape(input.subtitle ?? "")}</desc><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="${background}"/><stop offset="1" stop-color="${accent}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#bg)"/>${visual ? `<image x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" opacity=".16" href="${visual}"/>` : ""}<rect x="${margin / 2}" y="${margin / 2}" width="${w - margin}" height="${h - margin}" rx="32" fill="${surface}" fill-opacity=".82" stroke="${secondary}"/><image x="${margin}" y="${margin}" width="96" height="96" preserveAspectRatio="xMidYMid meet" href="${approvedLogo}"/><text x="${margin + 120}" y="${margin + 60}" fill="${secondary}" font-family="${escape(headingFont)},Arial,sans-serif" font-size="25" font-weight="700">${escape(brand)}</text>${textLines(titleLines, titleY, titleSize, titleSize * 1.18, text, 700, headingFont)}${textLines(bodyLines, bodyY, bodySize, bodySize * 1.45, secondary, 400, bodyFont)}${cta ? `<rect x="${margin}" y="${ctaY}" width="${Math.ceil(width(cta, 26)) + 48}" height="62" rx="16" fill="${primary}"/><text x="${margin + 24}" y="${ctaY + 40}" fill="${surface}" font-family="${escape(headingFont)},Arial,sans-serif" font-size="26" font-weight="700">${escape(cta)}</text>` : ""}</svg>`;
  return {
    status: "rendered" as const,
    filename: `creative-${input.format}.svg`,
    mime: "image/svg+xml" as const,
    svg,
    width: w,
    height: h,
    safeMargin: margin,
    contentHash: createHash("sha256").update(svg).digest("hex"),
    logoHash: input.logoHash ?? logoHash,
    visualHash: input.visualHash,
    palette,
    overflowChecked: true,
    format: input.format,
    note: "SVG export. Raster conversion and provider format acceptance are separate gates; no platform upload was performed.",
  };
}

/** Rasterizes only our fixed template, never arbitrary SVG, remote URLs, or user markup. */
export async function renderRasterTemplate(input: TemplateInput) {
  const rendered = renderTemplate(input);
  if (rendered.status !== "rendered") return rendered;
  const { default: sharp } = await import("sharp");
  try {
    const output = await sharp(Buffer.from(rendered.svg), {
      density: 72,
      limitInputPixels: 1080 * 1920,
      failOn: "warning",
      animated: false,
    })
      .timeout({ seconds: 10 })
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
      .toBuffer({ resolveWithObject: true });
    if (
      output.info.width !== rendered.width ||
      output.info.height !== rendered.height ||
      output.info.format !== "png" ||
      output.data.length > 20 * 1024 * 1024
    )
      throw new CreativeError("RASTER_OUTPUT_INVALID");
    return {
      ...rendered,
      filename: `creative-${input.format}.png`,
      mime: "image/png" as const,
      bytes: output.data,
      sourceSvgHash: rendered.contentHash,
      contentHash: createHash("sha256").update(output.data).digest("hex"),
      renderer: {
        name: "sharp",
        version: sharp.versions.sharp,
        libvips: sharp.versions.vips,
      },
      note: "Local PNG export with the original logo. Platform-specific crop and live upload acceptance remain unverified; raster bytes may vary by installed fonts and renderer version.",
    };
  } catch (error) {
    if (error instanceof CreativeError) throw error;
    throw new CreativeError("RASTER_RENDER_FAILED");
  }
}

export async function normalizeRasterAsset(
  bytes: Buffer,
  options: { maxInputBytes: number; maxOutputBytes: number; maxPixels: number },
) {
  if (!bytes.length || bytes.length > options.maxInputBytes)
    throw new CreativeError("RASTER_INPUT_INVALID");
  const { default: sharp } = await import("sharp");
  let metadata: import("sharp").Metadata;
  try {
    metadata = await sharp(bytes, {
      limitInputPixels: options.maxPixels,
      failOn: "warning",
      animated: false,
    }).metadata();
  } catch {
    throw new CreativeError("RASTER_INPUT_INVALID");
  }
  if (
    !["png", "jpeg", "webp"].includes(metadata.format ?? "") ||
    !metadata.width ||
    !metadata.height ||
    metadata.width < 32 ||
    metadata.height < 32 ||
    metadata.width * metadata.height > options.maxPixels ||
    (metadata.pages ?? 1) !== 1
  )
    throw new CreativeError("RASTER_INPUT_INVALID");
  try {
    const output = await sharp(bytes, {
      limitInputPixels: options.maxPixels,
      failOn: "warning",
      animated: false,
    })
      .rotate()
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
      .toBuffer({ resolveWithObject: true });
    if (
      !output.info.width ||
      !output.info.height ||
      output.info.format !== "png" ||
      output.data.length > options.maxOutputBytes
    )
      throw new CreativeError("RASTER_OUTPUT_INVALID");
    return {
      bytes: output.data,
      width: output.info.width,
      height: output.info.height,
      inputFormat: metadata.format as "png" | "jpeg" | "webp",
      sha256: createHash("sha256").update(output.data).digest("hex"),
    };
  } catch (error) {
    if (error instanceof CreativeError) throw error;
    throw new CreativeError("RASTER_NORMALIZATION_FAILED");
  }
}
