import {
  sha256Hex,
  type BrandPalette,
  type CreativeBrand,
  type RasterSource,
} from "../src/brand.ts";

// Fictional demo brands for tests, calibration and visual checks (spec §12).
// Every logo, screenshot and artwork is drawn here as SVG and rasterized with
// sharp, so the fixtures carry no third-party material. Bytes may differ
// between hosts (fonts, librsvg), hashes are always computed from the bytes.

export type DemoBrandName = "lumora" | "kestrel";
export type FixtureArtKind = "good" | "tiny_subject" | "flat" | "bright";
type Size = { width: number; height: number };

const FONT = "DejaVu Sans, Arial, Helvetica, sans-serif";

const PALETTES: Readonly<Record<DemoBrandName, BrandPalette>> = {
  // Lumora Home: warm home goods, coral on cream with a dark ink.
  lumora: {
    primaryColor: "#E8604C",
    secondaryColor: "#8C3B2C",
    accentColor: "#F6B26B",
    backgroundColor: "#FFF4E8",
    surfaceColor: "#FFF4E8",
    textColor: "#2B1B17",
    headingFont: "Inter",
    bodyFont: "Inter",
  },
  // Kestrel Analytics: teal and lime on white.
  kestrel: {
    primaryColor: "#0F4C5C",
    secondaryColor: "#082F38",
    accentColor: "#B5E655",
    backgroundColor: "#F2F6F5",
    surfaceColor: "#FFFFFF",
    textColor: "#0B1F24",
    headingFont: "DejaVu Sans",
    bodyFont: "DejaVu Sans",
  },
};

async function rasterize(svg: string): Promise<RasterSource> {
  const { default: sharp } = await import("sharp");
  const bytes = await sharp(Buffer.from(svg), { density: 72 })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();
  return { bytes, sha256: sha256Hex(bytes) };
}

/** Rasterizes once per key; every caller gets its own copy of the bytes. */
const cache = new Map<string, Promise<RasterSource>>();
async function cached(key: string, svg: () => string): Promise<RasterSource> {
  let source = cache.get(key);
  if (!source) {
    source = rasterize(svg());
    cache.set(key, source);
  }
  const { bytes, sha256 } = await source;
  return { bytes: Buffer.from(bytes), sha256 };
}

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Logos
// ---------------------------------------------------------------------------

function lumoraLogoSvg(wordmark: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="660" height="180" viewBox="0 0 660 180">
  <path d="M28 104 Q28 34 90 34 Q152 34 152 104 Z" fill="#E8604C"/>
  <rect x="86" y="6" width="8" height="30" rx="4" fill="#E8604C"/>
  <circle cx="90" cy="130" r="18" fill="#E8604C"/>
  <rect x="34" y="158" width="112" height="8" rx="4" fill="#E8604C"/>
  <text x="180" y="128" font-family="${FONT}" font-size="104" font-weight="700" letter-spacing="-3" fill="${wordmark}">lumora</text>
</svg>`;
}

function kestrelLogoSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="180" viewBox="0 0 700 180">
  <rect x="10" y="10" width="160" height="160" rx="38" fill="#0F4C5C"/>
  <path d="M54 44 H80 V82 L118 44 H150 L104 90 L152 136 H120 L80 98 V136 H54 Z" fill="#B5E655"/>
  <text x="196" y="124" font-family="${FONT}" font-size="96" font-weight="800" letter-spacing="-2" fill="#0F4C5C">Kestrel</text>
</svg>`;
}

/** A logo on an opaque white square, as owners sometimes upload them (Review Focus 3). */
export function opaqueLogo(): Promise<RasterSource> {
  return cached(
    "logo:opaque",
    () => `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
  <rect width="400" height="400" fill="#FFFFFF"/>
  <circle cx="200" cy="200" r="132" fill="#22262B"/>
  <path d="M136 252 L200 132 L264 252 Z" fill="#FFFFFF"/>
  <circle cx="200" cy="218" r="22" fill="#22262B"/>
</svg>`,
  );
}

/** Lumora Home (primary and onDark logos, pill CTA) or Kestrel Analytics (primary logo only). */
export async function demoBrand(name: DemoBrandName): Promise<CreativeBrand> {
  if (name === "lumora") {
    const [primary, onDark] = await Promise.all([
      cached("logo:lumora:primary", () => lumoraLogoSvg("#2B1B17")),
      cached("logo:lumora:onDark", () => lumoraLogoSvg("#FFF4E8")),
    ]);
    return {
      brandName: "Lumora Home",
      palette: { ...PALETTES.lumora },
      typography: { headingWeight: 700, headingCase: "none" },
      logos: [
        { ...primary, role: "primary" },
        { ...onDark, role: "onDark" },
      ],
      ctaStyle: "pill",
    };
  }
  const primary = await cached("logo:kestrel:primary", kestrelLogoSvg);
  return {
    brandName: "Kestrel Analytics",
    palette: { ...PALETTES.kestrel },
    typography: { headingWeight: 800, headingCase: "none" },
    logos: [{ ...primary, role: "primary" }],
    ctaStyle: "pill",
  };
}

// ---------------------------------------------------------------------------
// Product screenshots
// ---------------------------------------------------------------------------

function kestrelDashboard() {
  const kpis = [
    ["Active users", "48.2k", "+12%"],
    ["Conversion", "6.4%", "+0.8"],
    ["Revenue", "$182k", "+9%"],
    ["Churn", "1.9%", "-0.3"],
  ];
  const cards = kpis
    .map(
      ([label, value, delta], i) => `
    <rect x="${300 + i * 320}" y="190" width="290" height="150" rx="18" fill="#FFFFFF" stroke="#E1E8E6" stroke-width="2"/>
    <text x="${328 + i * 320}" y="236" font-family="${FONT}" font-size="20" fill="#5B6B70">${label}</text>
    <text x="${328 + i * 320}" y="298" font-family="${FONT}" font-size="46" font-weight="700" fill="#0B1F24">${value}</text>
    <rect x="${470 + i * 320}" y="268" width="92" height="36" rx="18" fill="#E9F8D2"/>
    <text x="${516 + i * 320}" y="293" font-family="${FONT}" font-size="18" font-weight="700" fill="#2F6B12" text-anchor="middle">${delta}</text>`,
    )
    .join("");
  const points = [
    620, 600, 640, 560, 580, 520, 540, 470, 500, 455, 430, 410, 380, 360,
  ];
  const line = points.map((y, i) => `${330 + i * 60},${y}`).join(" ");
  const nav = Array.from(
    { length: 7 },
    (_, i) =>
      `<rect x="36" y="${150 + i * 64}" width="188" height="40" rx="12" fill="${i === 1 ? "#B5E655" : "#FFFFFF"}" fill-opacity="${i === 1 ? 1 : 0.1}"/>`,
  ).join("");
  const bars = [90, 130, 70, 160, 120, 180, 140]
    .map(
      (h, i) =>
        `<rect x="${1230 + i * 44}" y="${740 - h}" width="28" height="${h}" rx="6" fill="${i === 5 ? "#B5E655" : "#0F4C5C"}"/>`,
    )
    .join("");
  const rows = Array.from(
    { length: 3 },
    (_, i) => `
    <rect x="330" y="${858 + i * 36}" width="${380 - i * 60}" height="14" rx="7" fill="#C9D6D3"/>
    <rect x="900" y="${858 + i * 36}" width="120" height="14" rx="7" fill="#DCE5E3"/>
    <rect x="1300" y="${858 + i * 36}" width="${200 - i * 30}" height="14" rx="7" fill="#0F4C5C" fill-opacity="0.7"/>`,
  ).join("");
  return `
  <rect width="1600" height="1000" fill="#F4F7F6"/>
  <rect width="260" height="1000" fill="#0F4C5C"/>
  <rect x="36" y="40" width="52" height="52" rx="14" fill="#B5E655"/>
  <text x="104" y="76" font-family="${FONT}" font-size="26" font-weight="700" fill="#FFFFFF">Kestrel</text>
  ${nav}
  <rect x="260" width="1340" height="96" fill="#FFFFFF"/>
  <rect x="300" y="28" width="440" height="40" rx="20" fill="#EEF2F1"/>
  <circle cx="1536" cy="48" r="24" fill="#B5E655"/>
  <text x="300" y="158" font-family="${FONT}" font-size="34" font-weight="700" fill="#0B1F24">Weekly overview</text>
  ${cards}
  <rect x="300" y="370" width="880" height="420" rx="18" fill="#FFFFFF" stroke="#E1E8E6" stroke-width="2"/>
  <text x="330" y="418" font-family="${FONT}" font-size="24" font-weight="700" fill="#0B1F24">Sessions</text>
  ${[480, 540, 600, 660, 720].map((y) => `<path d="M330 ${y} H1150" stroke="#EDF1F0" stroke-width="2"/>`).join("")}
  <path d="M${line.replaceAll(" ", " L")} L1110,760 L330,760 Z" fill="#0F4C5C" fill-opacity="0.12"/>
  <polyline points="${line}" fill="none" stroke="#0F4C5C" stroke-width="6" stroke-linejoin="round"/>
  <circle cx="1110" cy="360" r="10" fill="#B5E655" stroke="#0F4C5C" stroke-width="4"/>
  <rect x="1200" y="370" width="360" height="420" rx="18" fill="#FFFFFF" stroke="#E1E8E6" stroke-width="2"/>
  <text x="1230" y="418" font-family="${FONT}" font-size="24" font-weight="700" fill="#0B1F24">Goals</text>
  <circle cx="1380" cy="520" r="62" fill="none" stroke="#E3EAE8" stroke-width="22"/>
  <circle cx="1380" cy="520" r="62" fill="none" stroke="#0F4C5C" stroke-width="22" stroke-dasharray="270 400" transform="rotate(-90 1380 520)"/>
  <text x="1380" y="532" font-family="${FONT}" font-size="34" font-weight="700" fill="#0B1F24" text-anchor="middle">69%</text>
  ${bars}
  <rect x="300" y="820" width="1260" height="150" rx="18" fill="#FFFFFF" stroke="#E1E8E6" stroke-width="2"/>
  ${rows}`;
}

function lumoraShop() {
  const products = [
    ["Arc floor lamp", "$189", "lamp"],
    ["Linen lounge chair", "$420", "chair"],
    ["Stoneware vase", "$46", "vase"],
    ["Wool throw", "$78", "throw"],
  ] as const;
  const drawing = (kind: string, x: number) => {
    switch (kind) {
      case "lamp":
        return `<path d="M${x + 100} 760 V610 Q${x + 100} 560 ${x + 160} 560" fill="none" stroke="#2B1B17" stroke-width="8"/>
          <path d="M${x + 120} 600 Q${x + 160} 530 ${x + 210} 600 Z" fill="#E8604C"/><rect x="${x + 70}" y="756" width="70" height="12" rx="6" fill="#2B1B17"/>`;
      case "chair":
        return `<rect x="${x + 90}" y="600" width="160" height="110" rx="34" fill="#C98A3B"/><rect x="${x + 80}" y="680" width="180" height="60" rx="24" fill="#B87A2F"/>
          <rect x="${x + 100}" y="738" width="10" height="34" fill="#2B1B17"/><rect x="${x + 230}" y="738" width="10" height="34" fill="#2B1B17"/>`;
      case "vase":
        return `<path d="M${x + 140} 580 h60 q-8 40 22 80 q30 60 -10 112 h-84 q-40 -52 -10 -112 q30 -40 22 -80 z" fill="#8FA6A0"/><path d="M${x + 170} 580 q-10 -60 -50 -80 M${x + 170} 580 q20 -70 60 -76" stroke="#5E7A4F" stroke-width="6" fill="none"/>`;
      default:
        return `<rect x="${x + 70}" y="600" width="200" height="150" rx="20" fill="#E8604C"/><path d="M${x + 70} 640 h200 M${x + 70} 680 h200 M${x + 70} 720 h200" stroke="#FFF4E8" stroke-width="6"/>`;
    }
  };
  const cards = products
    .map(([name, price, kind], i) => {
      const x = 60 + i * 380;
      return `<rect x="${x}" y="520" width="340" height="440" rx="24" fill="#FFFFFF"/>
      <rect x="${x}" y="520" width="340" height="290" rx="24" fill="#F3E4D6"/>
      ${drawing(kind, x)}
      <text x="${x + 24}" y="868" font-family="${FONT}" font-size="26" font-weight="700" fill="#2B1B17">${name}</text>
      <text x="${x + 24}" y="910" font-family="${FONT}" font-size="24" fill="#8C3B2C">${price}</text>`;
    })
    .join("");
  return `
  <rect width="1600" height="1000" fill="#FFF8F1"/>
  <text x="60" y="72" font-family="${FONT}" font-size="40" font-weight="700" fill="#2B1B17">lumora</text>
  ${["Living", "Lighting", "Textiles", "Sale"].map((t, i) => `<text x="${560 + i * 150}" y="66" font-family="${FONT}" font-size="22" fill="#5A4640">${t}</text>`).join("")}
  <circle cx="1520" cy="58" r="24" fill="#E8604C"/>
  <rect x="60" y="110" width="1480" height="370" rx="30" fill="#F6D7C6"/>
  <text x="120" y="250" font-family="${FONT}" font-size="64" font-weight="700" fill="#2B1B17">Autumn light</text>
  <text x="120" y="310" font-family="${FONT}" font-size="28" fill="#5A4640">Warm lamps for long evenings</text>
  <rect x="120" y="356" width="220" height="64" rx="32" fill="#E8604C"/>
  <text x="230" y="398" font-family="${FONT}" font-size="24" font-weight="700" fill="#2B1B17" text-anchor="middle">Shop now</text>
  <ellipse cx="1180" cy="390" rx="260" ry="70" fill="#EBB79C"/>
  <path d="M1080 300 Q1180 150 1280 300 Z" fill="#E8604C"/>
  <rect x="1176" y="110" width="8" height="120" fill="#2B1B17"/>
  <ellipse cx="1180" cy="300" rx="100" ry="14" fill="#FFE7C2"/>
  ${cards}`;
}

/** An approved product screenshot of the brand's (fictional) app; 1600×1000 unless a size is given. */
export function fixtureScreenshot(
  brand: DemoBrandName,
  size: Size = { width: 1600, height: 1000 },
): Promise<RasterSource> {
  const { width, height } = size;
  return cached(
    `screenshot:${brand}:${width}x${height}`,
    () => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
  ${brand === "lumora" ? lumoraShop() : kestrelDashboard()}
</svg>`,
  );
}

// ---------------------------------------------------------------------------
// Artwork
//
// Scenes are drawn on a 1000×1000 core that is always fully visible; the
// backgrounds extend past it so that any aspect ratio is filled.
// ---------------------------------------------------------------------------

function viewBox({ width, height }: Size) {
  const aspect = width / height;
  const w = aspect >= 1 ? 1000 * aspect : 1000;
  const h = aspect >= 1 ? 1000 : 1000 / aspect;
  return { x: (1000 - w) / 2, y: (1000 - h) / 2, w, h };
}

/** Fine photographic grain over the visible area. */
function grain(
  vb: ReturnType<typeof viewBox>,
  opacity: number,
  frequency = 0.9,
) {
  return `<filter id="grain" x="0" y="0" width="1" height="1">
    <feTurbulence type="fractalNoise" baseFrequency="${frequency}" numOctaves="2" seed="7"/>
    <feColorMatrix type="saturate" values="0"/>
  </filter>
  <rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" filter="url(#grain)" opacity="${opacity}"/>`;
}

/**
 * In-focus texture inside a softly masked ellipse: light and dark specks in
 * equal measure (no grey veil), so the subject reads sharper than its
 * surroundings without changing their tone.
 */
function subjectDetail(
  area: { cx: number; cy: number; rx: number; ry: number },
  strength: number,
) {
  const { cx, cy, rx, ry } = area;
  const k = 2 * strength;
  return `<filter id="detail" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="1" seed="3" result="noise"/>
    <feColorMatrix in="noise" type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 ${k} 0 0 0 ${-k / 2}" result="light"/>
    <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${-k} 0 0 0 ${k / 2}" result="dark"/>
    <feMerge><feMergeNode in="dark"/><feMergeNode in="light"/></feMerge>
  </filter>
  <radialGradient id="focus"><stop offset="0.6" stop-color="#FFFFFF"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>
  <mask id="subject"><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#focus)"/></mask>
  <rect x="${cx - rx}" y="${cy - ry}" width="${2 * rx}" height="${2 * ry}" filter="url(#detail)" mask="url(#subject)"/>`;
}

/**
 * A dark, warm reading corner at dusk: pendant lamp and a large armchair in the
 * upper part, a calm floor in the bottom third (as the art prompt asks).
 */
function lumoraGood(vb: ReturnType<typeof viewBox>) {
  const leaves = Array.from({ length: 9 }, (_, i) => {
    const angle = -70 + i * 17;
    const length = 120 + (i % 3) * 30;
    return `<ellipse cx="170" cy="${560 - length / 2}" rx="26" ry="${length / 2}" fill="${i % 2 ? "#4F7A45" : "#6C9A55"}" transform="rotate(${angle} 170 620)"/>
    <ellipse cx="170" cy="${560 - length / 2}" rx="26" ry="${length / 2}" fill="url(#veins)" opacity="0.85" transform="rotate(${angle} 170 620)"/>`;
  }).join("");
  return `<defs>
    <linearGradient id="wall" gradientUnits="userSpaceOnUse" x1="0" y1="-300" x2="0" y2="630"><stop offset="0" stop-color="#170D0A"/><stop offset="1" stop-color="#3E2419"/></linearGradient>
    <linearGradient id="floor" gradientUnits="userSpaceOnUse" x1="0" y1="630" x2="0" y2="1250"><stop offset="0" stop-color="#2A1610"/><stop offset="1" stop-color="#0D0705"/></linearGradient>
    <linearGradient id="dusk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1B2744"/><stop offset="0.55" stop-color="#6A4862"/><stop offset="1" stop-color="#E4895A"/></linearGradient>
    <radialGradient id="glow"><stop offset="0" stop-color="#FFCB8A" stop-opacity="0.6"/><stop offset="0.45" stop-color="#F59A5B" stop-opacity="0.22"/><stop offset="1" stop-color="#F59A5B" stop-opacity="0"/></radialGradient>
    <linearGradient id="shade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#A93C29"/><stop offset="0.45" stop-color="#F27D60"/><stop offset="1" stop-color="#93321F"/></linearGradient>
    <pattern id="weave" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#C6873A"/><path d="M0 0h8v2H0zM0 4h8v1H0z" fill="#7A4515"/><path d="M0 0v8h1V0zM4 0v8h2V0z" fill="#F2C47C" opacity="0.85"/></pattern>
    <pattern id="veins" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><path d="M0 4h8" stroke="#24401F" stroke-width="2"/></pattern>
    <pattern id="lights" width="14" height="16" patternUnits="userSpaceOnUse"><rect x="4" y="5" width="4" height="5" fill="#FFD27A" opacity="0.9"/></pattern>
    <pattern id="rib" width="12" height="12" patternUnits="userSpaceOnUse"><path d="M6 0v12" stroke="#7E2A1B" stroke-width="2.5" opacity="0.55"/></pattern>
    <linearGradient id="form" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0.5"/><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.3"/></linearGradient>
    <pattern id="rug" width="44" height="22" patternUnits="userSpaceOnUse"><rect width="44" height="22" fill="#7A352B"/><path d="M0 11h44" stroke="#A3604B" stroke-width="3"/><path d="M0 4h44M0 18h44" stroke="#62291F" stroke-width="2"/><path d="M11 0v22M33 0v22" stroke="#8A4335" stroke-width="2"/></pattern>
  </defs>
  <rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${630 - vb.y}" fill="url(#wall)"/>
  <rect x="${vb.x}" y="630" width="${vb.w}" height="${vb.y + vb.h - 630}" fill="url(#floor)"/>
  <g transform="translate(0 -150) translate(480 560) scale(1.14) translate(-480 -560)">
  <rect x="640" y="110" width="272" height="444" fill="#110907"/>
  <rect x="656" y="126" width="240" height="412" fill="url(#dusk)"/>
  <path d="M656 538 V470 h30 v-34 h28 v52 h22 v-74 h30 v62 h24 v-22 h30 v44 h22 v-30 h54 V538Z" fill="#2A2036" opacity="0.85"/>
  <path d="M656 538 V470 h30 v-34 h28 v52 h22 v-74 h30 v62 h24 v-22 h30 v44 h22 v-30 h54 V538Z" fill="url(#lights)"/>
  <rect x="771" y="126" width="10" height="412" fill="#110907"/>
  <rect x="656" y="324" width="240" height="10" fill="#110907"/>
  <ellipse cx="480" cy="902" rx="410" ry="74" fill="url(#rug)"/>
  <rect x="122" y="640" width="96" height="140" rx="14" fill="#9A4A33"/>
  <rect x="122" y="640" width="96" height="140" rx="14" fill="url(#form)"/>
  ${leaves}
  <rect x="290" y="790" width="22" height="58" rx="6" fill="#140B08"/>
  <rect x="648" y="790" width="22" height="58" rx="6" fill="#140B08"/>
  <rect x="300" y="420" width="360" height="300" rx="72" fill="url(#weave)"/>
  <rect x="300" y="420" width="360" height="300" rx="72" fill="url(#form)"/>
  <rect x="250" y="560" width="104" height="236" rx="46" fill="url(#weave)"/>
  <rect x="250" y="560" width="104" height="236" rx="46" fill="url(#form)"/>
  <rect x="606" y="560" width="104" height="236" rx="46" fill="url(#weave)"/>
  <rect x="606" y="560" width="104" height="236" rx="46" fill="url(#form)" opacity="0.7"/>
  <rect x="334" y="652" width="292" height="128" rx="40" fill="url(#weave)"/>
  <rect x="334" y="652" width="292" height="128" rx="40" fill="#000" opacity="0.18"/>
  <rect x="418" y="512" width="150" height="128" rx="38" fill="#E8604C" transform="rotate(-9 493 576)"/>
  <path d="M430 540 h126 M430 580 h126 M430 620 h126" stroke="#F49A84" stroke-width="5" transform="rotate(-9 493 576)"/>
  <ellipse cx="780" cy="642" rx="82" ry="18" fill="#5A3324"/>
  <rect x="772" y="642" width="16" height="190" fill="#3A2016"/>
  <rect x="742" y="602" width="54" height="40" rx="8" fill="#E8604C"/>
  <rect x="806" y="616" width="34" height="26" rx="6" fill="#FFF4E8"/>
  <rect x="497" y="-400" width="6" height="660" fill="#0C0705"/>
  <path d="M388 364 Q388 252 500 252 Q612 252 612 364 Z" fill="url(#shade)"/>
  <path d="M388 364 Q388 252 500 252 Q612 252 612 364 Z" fill="url(#rib)"/>
  <ellipse cx="500" cy="364" rx="112" ry="17" fill="#FFE4B5"/>
  <ellipse cx="500" cy="560" rx="470" ry="420" fill="url(#glow)"/>
  ${subjectDetail({ cx: 470, cy: 540, rx: 480, ry: 360 }, 0.8)}
  </g>
  ${grain(vb, 0.16)}`;
}

/**
 * A light "data horizon": isometric bars with lime tops and an orbit ring in the
 * upper part, a calm dark ground in the bottom third.
 */
function kestrelGood(vb: ReturnType<typeof viewBox>) {
  const s = 84;
  const u = [0.866 * s * 1.22, 0.5 * s * 1.22];
  const v = [-0.866 * s * 1.22, 0.5 * s * 1.22];
  const heights = [
    [210, 300, 250, 380],
    [170, 260, 330, 430],
    [120, 220, 280, 360],
  ];
  const origin = [470, 470];
  const bars: string[] = [];
  const cells: { i: number; j: number }[] = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) cells.push({ i, j });
  cells.sort((a, b) => a.i + a.j - (b.i + b.j));
  for (const { i, j } of cells) {
    const px = origin[0]! + i * u[0]! + j * v[0]!;
    const py = origin[1]! + i * u[1]! + j * v[1]! - 120;
    const h = heights[j]![i]!;
    const fw = 0.86;
    const A = [px, py];
    const B = [px + u[0]! * fw, py + u[1]! * fw];
    const D = [px + v[0]! * fw, py + v[1]! * fw];
    const C = [B[0]! + v[0]! * fw, B[1]! + v[1]! * fw];
    const up = (p: number[]) => `${p[0]!.toFixed(1)},${(p[1]! - h).toFixed(1)}`;
    const at = (p: number[]) => `${p[0]!.toFixed(1)},${p[1]!.toFixed(1)}`;
    const lime = (i + j) % 3 === 0 || h > 400;
    bars.push(
      `<polygon points="${at(D)} ${at(C)} ${up(C)} ${up(D)}" fill="#156F82"/>`,
      `<polygon points="${at(D)} ${at(C)} ${up(C)} ${up(D)}" fill="url(#hatch)"/>`,
      `<polygon points="${at(C)} ${at(B)} ${up(B)} ${up(C)}" fill="#0B4352"/>`,
      `<polygon points="${at(C)} ${at(B)} ${up(B)} ${up(C)}" fill="url(#hatch)"/>`,
      `<polygon points="${up(A)} ${up(B)} ${up(C)} ${up(D)}" fill="${lime ? "#B5E655" : "#7CC7B9"}"/>`,
      `<path d="M${up(D)} L${up(C)} L${up(B)}" stroke="#E9FFD0" stroke-width="2" fill="none" opacity="0.6"/>`,
    );
  }
  const trail = [
    [140, 330],
    [260, 300],
    [380, 320],
    [500, 240],
    [620, 215],
    [740, 150],
    [860, 115],
  ];
  return `<defs>
    <linearGradient id="sky" gradientUnits="userSpaceOnUse" x1="0" y1="-300" x2="0" y2="540"><stop offset="0" stop-color="#F4FBF8"/><stop offset="1" stop-color="#9FCFC2"/></linearGradient>
    <radialGradient id="sun"><stop offset="0" stop-color="#F3FFD6"/><stop offset="0.6" stop-color="#E2F6B8" stop-opacity="0.5"/><stop offset="1" stop-color="#E2F6B8" stop-opacity="0"/></radialGradient>
    <linearGradient id="ground" gradientUnits="userSpaceOnUse" x1="0" y1="530" x2="0" y2="1250"><stop offset="0" stop-color="#176172"/><stop offset="1" stop-color="#04222A"/></linearGradient>
    <pattern id="hatch" width="10" height="9" patternUnits="userSpaceOnUse"><path d="M0 4.5h10" stroke="#E9FFD0" stroke-width="2" opacity="0.55"/><path d="M5 0v9" stroke="#04222A" stroke-width="1.5" opacity="0.3"/></pattern>
    <pattern id="grid" width="36" height="36" patternUnits="userSpaceOnUse"><path d="M36 0H0V36" fill="none" stroke="#5FB3A8" stroke-width="1.5" opacity="0.25"/></pattern>
    <clipPath id="back"><rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${400 - vb.y}"/></clipPath>
    <clipPath id="front"><rect x="${vb.x}" y="400" width="${vb.w}" height="${vb.y + vb.h - 400}"/></clipPath>
  </defs>
  <rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${540 - vb.y}" fill="url(#sky)"/>
  <circle cx="640" cy="200" r="300" fill="url(#sun)"/>
  <path d="M${vb.x} 540 Q 200 480 420 516 T 820 490 T ${vb.x + vb.w} 508 V 560 H ${vb.x} Z" fill="#7DB7AA"/>
  <rect x="${vb.x}" y="540" width="${vb.w}" height="${vb.y + vb.h - 540}" fill="url(#ground)"/>
  <rect x="${vb.x}" y="540" width="${vb.w}" height="${vb.y + vb.h - 540}" fill="url(#grid)"/>
  <ellipse cx="500" cy="400" rx="440" ry="104" fill="none" stroke="#B5E655" stroke-width="7" clip-path="url(#back)" opacity="0.9"/>
  ${bars.join("\n  ")}
  <ellipse cx="500" cy="400" rx="440" ry="104" fill="none" stroke="#B5E655" stroke-width="7" clip-path="url(#front)"/>
  <polyline points="${trail.map((p) => p.join(",")).join(" ")}" fill="none" stroke="#0F4C5C" stroke-width="5" stroke-dasharray="14 10"/>
  ${trail.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="13" fill="#FFFFFF" stroke="#0F4C5C" stroke-width="5"/>`).join("")}
  ${subjectDetail({ cx: 490, cy: 340, rx: 450, ry: 350 }, 0.8)}
  ${grain(vb, 0.14)}`;
}

/** A tiny detailed object on a smooth, empty field. */
function tinySubject(brand: DemoBrandName, vb: ReturnType<typeof viewBox>) {
  const [top, bottom] =
    brand === "lumora" ? ["#F6E7D8", "#EBD3C0"] : ["#E3F0EC", "#CFE3DD"];
  const subject =
    brand === "lumora"
      ? `<rect x="558" y="470" width="4" height="40" fill="#2B1B17"/><path d="M536 532 Q536 506 560 506 Q584 506 584 532 Z" fill="#E8604C"/><path d="M540 524 h40" stroke="#FFE4B5" stroke-width="3"/>`
      : `<rect x="540" y="500" width="12" height="40" fill="#0F4C5C"/><rect x="556" y="486" width="12" height="54" fill="#B5E655"/><rect x="572" y="510" width="12" height="30" fill="#0F4C5C"/>`;
  return `<defs><linearGradient id="field" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>
  <rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="url(#field)"/>
  ${subject}`;
}

/** An almost uniform field. */
function flat(brand: DemoBrandName, vb: ReturnType<typeof viewBox>) {
  const [top, bottom] =
    brand === "lumora" ? ["#F2E2D2", "#EEDBC9"] : ["#DDEBE6", "#D5E6E0"];
  return `<defs><linearGradient id="field" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>
  <rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="url(#field)"/>`;
}

/** A bright, busy scene: pastel bokeh, confetti and stripes everywhere. */
function bright(brand: DemoBrandName, vb: ReturnType<typeof viewBox>) {
  const next = random(brand === "lumora" ? 11 : 23);
  const pastels =
    brand === "lumora"
      ? ["#FFD9C7", "#FFE8B0", "#F9C6B5", "#FFF1DC", "#F4A58F"]
      : ["#D8F3A8", "#C9EDE4", "#E8FAD0", "#BFE3DA", "#9FD8C9"];
  const ink = brand === "lumora" ? "#E8604C" : "#0F4C5C";
  const pick = (list: string[]) => list[Math.floor(next() * list.length)]!;
  const shapes: string[] = [];
  for (let k = 0; k < 220; k++) {
    const x = vb.x + next() * vb.w;
    const y = vb.y + next() * vb.h;
    const r = 14 + next() * 70;
    shapes.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${pick(pastels)}" opacity="${(0.45 + next() * 0.5).toFixed(2)}"/>`,
    );
  }
  for (let k = 0; k < 160; k++) {
    const x = vb.x + next() * vb.w;
    const y = vb.y + next() * vb.h;
    const angle = Math.floor(next() * 180);
    shapes.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(10 + next() * 26).toFixed(1)}" height="5" rx="2" fill="${next() < 0.4 ? ink : pick(pastels)}" transform="rotate(${angle} ${x.toFixed(1)} ${y.toFixed(1)})"/>`,
    );
  }
  return `<defs><pattern id="stripes" width="22" height="22" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><rect width="22" height="22" fill="#FFFFFF"/><rect width="8" height="22" fill="${pastels[3]}"/></pattern></defs>
  <rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="url(#stripes)"/>
  ${shapes.join("\n  ")}
  ${grain(vb, 0.1)}`;
}

/**
 * Artwork as an image model would deliver it (1024×1024 unless a size is given):
 * `good` is a strong scene with a large subject (dark for Lumora, light sky over a
 * dark ground for Kestrel), `tiny_subject` a small object on a smooth field,
 * `flat` an almost uniform field and `bright` a bright, busy scene.
 */
export function fixtureArt(
  kind: FixtureArtKind,
  brand: DemoBrandName,
  size: Size = { width: 1024, height: 1024 },
): Promise<RasterSource> {
  const vb = viewBox(size);
  const body = () => {
    switch (kind) {
      case "good":
        return brand === "lumora" ? lumoraGood(vb) : kestrelGood(vb);
      case "tiny_subject":
        return tinySubject(brand, vb);
      case "flat":
        return flat(brand, vb);
      case "bright":
        return bright(brand, vb);
    }
  };
  return cached(
    `art:${kind}:${brand}:${size.width}x${size.height}`,
    () => `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}">
  ${body()}
</svg>`,
  );
}
