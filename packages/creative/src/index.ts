import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { BrandPalette } from "./brand.ts";
import { CreativeError } from "./errors.ts";
export * from "./brand.ts";
export * from "./errors.ts";
export * from "./formats.ts";
export * from "./ids.ts";
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
  // 16:9, the format of the brand banner (R78).
  wide: [1600, 900],
} as const;
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
  return {
    ...rendered,
    ...(await rasterize(rendered)),
    filename: `creative-${input.format}.png`,
    note: "Local PNG export with the original logo. Platform-specific crop and live upload acceptance remain unverified; raster bytes may vary by installed fonts and renderer version.",
  };
}

/** PNG pixels of one of our own rendered SVGs, checked for its size. */
async function rasterize(rendered: {
  svg: string;
  width: number;
  height: number;
  contentHash: string;
}) {
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
      mime: "image/png" as const,
      bytes: output.data,
      sourceSvgHash: rendered.contentHash,
      contentHash: createHash("sha256").update(output.data).digest("hex"),
      renderer: {
        name: "sharp",
        version: sharp.versions.sharp,
        libvips: sharp.versions.vips,
      },
    };
  } catch (error) {
    if (error instanceof CreativeError) throw error;
    throw new CreativeError("RASTER_RENDER_FAILED");
  }
}

/**
 * The brand banner (R78): one fixed 16:9 layout in the uLiquid style. Over a
 * background (the assignment run's generated art without text or logos, or
 * the template's own navy and waves) it places a dark shade on the left for
 * legibility, the approved logo with the wordmark, a two-part headline in
 * capitals (part 1 white, part 2 cyan), a subline, an outlined button (left
 * out when its label is empty), a
 * divider and the footer domain on the left, and a glass card holding the
 * approved logo on the right. The copy is used exactly as given (only shown
 * in capitals for the headline); text that does not fit throws
 * `TEXT_OVERFLOW` and is never cut. The logo is never generated or changed.
 */
export const bannerTemplates = {
  brand_landscape: templateFormats.wide,
} as const;
export type BannerTemplate = keyof typeof bannerTemplates;
export type BannerText = {
  headline1: string;
  headline2: string;
  subline: string;
  button: string;
};
/** Characters the copywriter is asked to keep to; the layout check below decides. */
export const BANNER_TEXT_LIMITS: Readonly<Record<keyof BannerText, number>> = {
  headline1: 18,
  headline2: 22,
  subline: 48,
  button: 18,
};
/** Hard bound of a banner field before any layout. */
export const BANNER_TEXT_MAX = 120;
export type BannerInput = {
  template: BannerTemplate;
  text: BannerText;
  // The wordmark: its last word is set in the accent colour ("uLiquid" + "Desk").
  brandName: string;
  // The domain of the post's official link.
  footer: string;
  logoApproved?: boolean;
  // A raster logo; without one the bundled original logo is used.
  logoDataUri?: string;
  // The approved logo asset's stored SHA-256: the bytes must match it.
  logoSha256?: string;
  backgroundDataUri?: string;
};

const BANNER = {
  margin: 96,
  column: 800,
  headline: { size: 80, lineHeight: 86, maxLines: 4 },
  subline: { size: 32, lineHeight: 42, maxLines: 2 },
  button: { size: 28, height: 68, padding: 30, arrow: 34 },
  wordmark: 38,
  footer: 24,
  // The left block sits between the wordmark and the divider.
  top: 180,
  bottom: 770,
  divider: 806,
  card: { x: 1188, y: 450, size: 248 },
  navy: "#040B1A",
  navyLight: "#0B1D3A",
  cyan: "#22D3EE",
  cyanDeep: "#0EA5E9",
  white: "#FFFFFF",
} as const;
const upper = (value: string) => value.trim().toUpperCase();

function bannerInputValid(text: BannerText, brandName: string, footer: string) {
  const fields = [text.headline1, text.headline2, text.subline, text.button];
  return (
    fields.every(
      (field) => typeof field === "string" && field.length <= BANNER_TEXT_MAX,
    ) &&
    // The button may be empty: the banner then has none.
    [text.headline1, text.headline2, text.subline].every(
      (field) => field.trim().length > 0,
    ) &&
    chromeValid(brandName, footer) &&
    !/[\u0000-\u001f]/u.test(fields.join(""))
  );
}

const chromeValid = (brandName: string, footer: string) =>
  typeof brandName === "string" &&
  brandName.trim().length > 0 &&
  brandName.length <= 80 &&
  typeof footer === "string" &&
  footer.trim().length > 0 &&
  footer.length <= 120 &&
  !/[\u0000-\u001f]/u.test(brandName + footer);

/**
 * Whether the parts of a banner the copywriter cannot change — the wordmark
 * (product name) and the footer domain — are invalid or too wide for the
 * template (R78). Copy can be revised; these cannot.
 */
export function bannerChromeOverflow(brandName: string, footer: string) {
  return (
    !chromeValid(brandName, footer) ||
    width(footer, BANNER.footer) > BANNER.column ||
    width(brandName, BANNER.wordmark) > BANNER.column - 92
  );
}

/** The width of an outlined button with this label, arrow included. */
const buttonWidthOf = (label: string) =>
  Math.ceil(
    width(label, BANNER.button.size) +
      2 * BANNER.button.padding +
      BANNER.button.arrow +
      16,
  );

/** Whether a button label fits the template's column (an empty label is no button). */
export function bannerButtonFits(label: string) {
  const trimmed = label.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= BANNER_TEXT_MAX &&
    !/[\u0000-\u001f]/u.test(trimmed) &&
    buttonWidthOf(trimmed) <= BANNER.column
  );
}

/** Lines and positions of the banner's text; throws `TEXT_OVERFLOW` when it does not fit. */
function bannerLayout(text: BannerText, brandName: string, footer: string) {
  if (!bannerInputValid(text, brandName, footer))
    throw new CreativeError("INVALID_TEMPLATE_INPUT");
  const { column, headline, subline, button } = BANNER;
  const headline1 = wrap(upper(text.headline1), column, headline.size, 2);
  const headline2 = wrap(upper(text.headline2), column, headline.size, 2);
  if (headline1.length + headline2.length > headline.maxLines)
    throw new CreativeError("TEXT_OVERFLOW");
  const sublineLines = wrap(
    text.subline,
    column,
    subline.size,
    subline.maxLines,
  );
  const buttonText = text.button.trim();
  const buttonWidth = buttonText ? buttonWidthOf(buttonText) : 0;
  if (buttonWidth > column) throw new CreativeError("TEXT_OVERFLOW");
  if (bannerChromeOverflow(brandName, footer))
    throw new CreativeError("TEXT_OVERFLOW");
  const headlineLines = headline1.length + headline2.length;
  const block =
    headlineLines * headline.lineHeight +
    36 +
    sublineLines.length * subline.lineHeight +
    (buttonText ? 44 + button.height : 0);
  const room = BANNER.bottom - BANNER.top;
  if (block > room) throw new CreativeError("TEXT_OVERFLOW");
  const top = BANNER.top + Math.floor((room - block) / 2);
  const sublineTop = top + headlineLines * headline.lineHeight + 36;
  const buttonTop = sublineTop + sublineLines.length * subline.lineHeight + 44;
  return {
    headline1,
    headline2,
    subline: sublineLines,
    button: buttonText,
    buttonWidth,
    top,
    sublineTop,
    buttonTop,
  };
}

/** Whether banner copy fits the layout (the review checks it before any image work). */
export function bannerTextOverflow(
  text: BannerText,
  brandName = "Brand",
  footer = "example.com",
) {
  try {
    bannerLayout(text, brandName, footer);
    return false;
  } catch (error) {
    if (error instanceof CreativeError && error.code === "TEXT_OVERFLOW")
      return true;
    throw error;
  }
}

export function renderBrandBanner(input: BannerInput) {
  if (!Object.hasOwn(bannerTemplates, input.template))
    throw new CreativeError("INVALID_TEMPLATE_INPUT");
  const layout = bannerLayout(input.text, input.brandName, input.footer);
  if (input.logoApproved !== true)
    return {
      status: "blocked_asset" as const,
      creativeBrief: {
        format: "wide" as const,
        title: `${input.text.headline1} ${input.text.headline2}`,
        subtitle: input.text.subline,
        requiredAsset: "Approved original project logo",
        nextStep: "Approve a source asset before rendering an export.",
      },
    };
  // The logo is used only as the approved asset's exact bytes.
  const rasterLogo = dataImage(input.logoDataUri);
  const rasterLogoHash = rasterLogo ? dataUriHash(rasterLogo) : null;
  if (
    rasterLogo &&
    (!input.logoSha256 || rasterLogoHash !== input.logoSha256.toLowerCase())
  )
    throw new CreativeError("BRAND_ASSET_INTEGRITY_FAILED");
  const approvedLogo =
    rasterLogo ?? `data:image/svg+xml;base64,${logo.toString("base64")}`;
  const background = dataImage(input.backgroundDataUri);
  const [w, h] = bannerTemplates[input.template];
  const { margin, headline, subline, button, card, cyan, white, navy } = BANNER;
  const family = "Inter, DejaVu Sans, Arial, sans-serif";
  const words = input.brandName.trim().split(/\s+/u);
  const accentWord = words.length > 1 ? words.pop()! : null;
  const wordmark = `<text data-layer="wordmark" x="${margin + 92}" y="${58 + 50}" font-family="${family}" font-size="${BANNER.wordmark}" font-weight="700" fill="${white}"><tspan>${escape(words.join(" "))}</tspan>${accentWord ? `<tspan dx="${Math.round(BANNER.wordmark * 0.3)}" fill="${cyan}">${escape(accentWord)}</tspan>` : ""}</text>`;
  const headlineText = (
    lines: string[],
    first: number,
    fill: string,
    layer: string,
  ) =>
    `<text data-layer="${layer}" x="${margin}" y="${layout.top + first * headline.lineHeight + Math.round(headline.size * 0.8)}" fill="${fill}" font-family="${family}" font-size="${headline.size}" font-weight="700">${lines.map((line, i) => `<tspan x="${margin}" dy="${i ? headline.lineHeight : 0}">${escape(line)}</tspan>`).join("")}</text>`;
  const buttonY = layout.buttonTop;
  const arrowX = margin + layout.buttonWidth - button.padding - button.arrow;
  const arrowY = buttonY + button.height / 2;
  const cardX = card.x - card.size / 2;
  const cardY = card.y - card.size / 2;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="title desc">`,
    `<title id="title">${escape(`${input.text.headline1} ${input.text.headline2}`)}</title><desc id="desc">${escape(input.text.subline)}</desc>`,
    `<defs>`,
    `<linearGradient id="base" x2="1" y2="1"><stop stop-color="${navy}"/><stop offset="1" stop-color="${BANNER.navyLight}"/></linearGradient>`,
    `<linearGradient id="shade" x2="1"><stop stop-color="${navy}" stop-opacity=".94"/><stop offset=".42" stop-color="${navy}" stop-opacity=".8"/><stop offset=".62" stop-color="${navy}" stop-opacity="0"/></linearGradient>`,
    `<linearGradient id="accent" x2="1"><stop stop-color="${cyan}"/><stop offset="1" stop-color="${BANNER.cyanDeep}"/></linearGradient>`,
    `<radialGradient id="glow" cx="${card.x}" cy="${card.y}" r="360" gradientUnits="userSpaceOnUse"><stop stop-color="${cyan}" stop-opacity=".28"/><stop offset="1" stop-color="${cyan}" stop-opacity="0"/></radialGradient>`,
    `<linearGradient id="glass" x2="0" y2="1"><stop stop-color="#16325A" stop-opacity=".9"/><stop offset="1" stop-color="${navy}" stop-opacity=".92"/></linearGradient>`,
    `</defs>`,
    `<rect data-layer="base" width="${w}" height="${h}" fill="url(#base)"/>`,
    background
      ? `<image data-layer="background" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" href="${background}"/>`
      : `<path data-layer="wave" d="M0 640 C 320 560 560 760 900 650 S 1400 520 1600 600" fill="none" stroke="${cyan}" stroke-opacity=".35" stroke-width="2"/><path data-layer="wave" d="M0 700 C 360 610 620 820 960 700 S 1420 590 1600 660" fill="none" stroke="${cyan}" stroke-opacity=".18" stroke-width="1.5"/>`,
    `<rect data-layer="glow" width="${w}" height="${h}" fill="url(#glow)"/>`,
    `<rect data-layer="shade" width="${w}" height="${h}" fill="url(#shade)"/>`,
    `<image data-layer="logo" x="${margin}" y="58" width="72" height="72" preserveAspectRatio="xMidYMid meet" href="${approvedLogo}"/>`,
    wordmark,
    headlineText(layout.headline1, 0, white, "headline1"),
    headlineText(
      layout.headline2,
      layout.headline1.length,
      "url(#accent)",
      "headline2",
    ),
    `<text data-layer="subline" x="${margin}" y="${layout.sublineTop + Math.round(subline.size * 0.8)}" fill="${white}" fill-opacity=".92" font-family="${family}" font-size="${subline.size}">${layout.subline.map((line, i) => `<tspan x="${margin}" dy="${i ? subline.lineHeight : 0}">${escape(line)}</tspan>`).join("")}</text>`,
    ...(layout.button
      ? [
          `<rect data-layer="button" x="${margin}" y="${buttonY}" width="${layout.buttonWidth}" height="${button.height}" rx="16" fill="${navy}" fill-opacity=".55" stroke="${cyan}" stroke-width="2"/>`,
          `<text data-layer="button-label" x="${margin + button.padding}" y="${buttonY + 44}" fill="${white}" font-family="${family}" font-size="${button.size}" font-weight="700">${escape(layout.button)}</text>`,
          `<path data-layer="button-arrow" d="M${arrowX} ${arrowY} H${arrowX + button.arrow} M${arrowX + button.arrow - 11} ${arrowY - 10} L${arrowX + button.arrow} ${arrowY} L${arrowX + button.arrow - 11} ${arrowY + 10}" fill="none" stroke="${cyan}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
        ]
      : []),
    `<line data-layer="divider" x1="${margin}" y1="${BANNER.divider}" x2="${w - margin}" y2="${BANNER.divider}" stroke="${white}" stroke-opacity=".18"/>`,
    `<text data-layer="footer" x="${margin}" y="${BANNER.divider + 46}" fill="${white}" fill-opacity=".8" font-family="${family}" font-size="${BANNER.footer}">${escape(input.footer.trim())}</text>`,
    `<rect data-layer="card" x="${cardX}" y="${cardY}" width="${card.size}" height="${card.size}" rx="36" fill="url(#glass)" stroke="${cyan}" stroke-opacity=".6" stroke-width="2"/>`,
    `<image data-layer="card-logo" x="${card.x - 84}" y="${card.y - 84}" width="168" height="168" preserveAspectRatio="xMidYMid meet" href="${approvedLogo}"/>`,
    `</svg>`,
  ].join("");
  return {
    status: "rendered" as const,
    template: input.template,
    filename: `banner-${input.template}.svg`,
    mime: "image/svg+xml" as const,
    svg,
    width: w,
    height: h,
    safeMargin: margin,
    lines: {
      headline1: layout.headline1,
      headline2: layout.headline2,
      subline: layout.subline,
    },
    contentHash: createHash("sha256").update(svg).digest("hex"),
    logoHash: rasterLogoHash ?? logoHash,
    backgroundHash: background ? dataUriHash(background) : undefined,
    overflowChecked: true,
  };
}

/** SHA-256 of a validated base64 data URI's bytes. */
const dataUriHash = (uri: string) =>
  createHash("sha256")
    .update(Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64"))
    .digest("hex");

/** The brand banner as PNG; same bounded rasterization as the templates. */
export async function renderRasterBanner(input: BannerInput) {
  const rendered = renderBrandBanner(input);
  if (rendered.status !== "rendered") return rendered;
  return {
    ...rendered,
    ...(await rasterize(rendered)),
    filename: `banner-${input.template}.png`,
  };
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

/** Re-encode an already normalized raster without carrying source metadata. */
export async function encodeWebp(bytes: Buffer) {
  const { default: sharp } = await import("sharp");
  return sharp(bytes, { limitInputPixels: 16_000_000, animated: false })
    .webp({ quality: 90 })
    .toBuffer();
}
