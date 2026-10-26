import type { RelBox } from "../../../../../../packages/creative/src/index.ts";
import type { MarketingProfile } from "../brand/marketing-profile.ts";
import { oneLine, type ResolvedBrief } from "./brief.ts";

/** The fixed negatives of every art prompt (spec §7). */
export const ART_NEGATIVES =
  "No text, letters, numbers, logos, watermarks, signage, user interfaces or screens with content. No tiny isolated subject, no empty plain background. No real or famous persons.";

/** What a failed art check asks the next generation to change. */
export type ArtCorrection = {
  kind: "subject_larger" | "calm_text_zone" | "more_detail";
  /** The finding in a few words; added to the prompt as it is. */
  note?: string;
};

/** The longest prompt the studio sends. */
const MAX_PROMPT = 4000;

const IMAGERY_STYLE = {
  photo: "a realistic photograph with natural light and true-to-life materials",
  illustration:
    "a crafted illustration with confident shapes, clean edges and rich colour",
  "3d": "a polished 3D render with soft studio lighting and tactile materials",
  flat: "a flat vector-style illustration with bold, simple shapes and no photographic texture",
  mixed: "a photographic subject combined with a few clean graphic elements",
} as const;

/** A colour as a word an image model understands ("dark teal"); hex alone it reads poorly. */
function colourWord(hex: string): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex);
  if (!match) return "";
  const [r, g, b] = match.slice(1).map((part) => parseInt(part, 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const spread = max - min;
  const saturation =
    spread === 0 ? 0 : spread / (1 - Math.abs(2 * lightness - 1));
  if (lightness > 0.92) return "off-white";
  if (lightness < 0.08) return "near-black";
  if (saturation < 0.12)
    return lightness < 0.35
      ? "dark grey"
      : lightness < 0.7
        ? "grey"
        : "light grey";
  const hue =
    ((max === r
      ? ((g - b) / spread) % 6
      : max === g
        ? (b - r) / spread + 2
        : (r - g) / spread + 4) *
      60 +
      360) %
    360;
  const base =
    hue < 15 || hue >= 345
      ? "red"
      : hue < 40
        ? lightness < 0.4
          ? "brown"
          : "orange"
        : hue < 65
          ? "yellow"
          : hue < 90
            ? "lime green"
            : hue < 165
              ? "green"
              : hue < 195
                ? "teal"
                : hue < 255
                  ? "blue"
                  : hue < 290
                    ? "purple"
                    : "pink";
  const tone =
    lightness < 0.25
      ? "very dark"
      : lightness < 0.4
        ? "dark"
        : lightness > 0.7
          ? "light"
          : "";
  return tone && base !== "brown" ? `${tone} ${base}` : base;
}

const portion = (share: number) =>
  share < 0.29
    ? "quarter"
    : share < 0.46
      ? "third"
      : share < 0.62
        ? "half"
        : "two thirds";

/** A zone (fractions of the canvas) by name, and where the rest of the image lies. */
function region(zone: RelBox) {
  const centreX = zone.x + zone.w / 2;
  const centreY = zone.y + zone.h / 2;
  if (zone.w <= 0.65) {
    const left = centreX < 0.5;
    return {
      name: `${left ? "left" : "right"} ${portion(zone.w)}`,
      rest: left ? "on the right" : "on the left",
    };
  }
  if (centreY < 0.4 || centreY > 0.6) {
    const top = centreY < 0.4;
    return {
      name: `${top ? "top" : "bottom"} ${portion(zone.h)}`,
      rest: top ? "in the lower part" : "in the upper part",
    };
  }
  return {
    name: "middle",
    rest:
      zone.y >= 1 - zone.y - zone.h
        ? "mostly in the upper part"
        : "mostly in the lower part",
  };
}

/**
 * Where the text goes, from its zone (fractions of the canvas): the area to
 * keep calm and the sentence that places the subject elsewhere. A product
 * screenshot covers its own zone, so the scene is built around that instead.
 */
function placement(text: RelBox | undefined, product: RelBox | undefined) {
  const zone = region(text ?? { x: 0.07, y: 0.6, w: 0.87, h: 0.33 });
  const calm =
    zone.name === "middle"
      ? "Keep the middle calm and soft for text added later"
      : `Keep the ${zone.name} calm and uncluttered for text added later`;
  return {
    area: zone.name,
    sentence: product
      ? `${calm}. The real product screenshot is added over the ${region(product).name} later, so build the scene around that area instead of placing the main subject there.`
      : zone.name === "middle"
        ? `${calm}; compose the subject around it, ${zone.rest}.`
        : `${calm}; place the subject ${zone.rest}.`,
  };
}

const sentence = (label: string, text: string) =>
  text ? `${label}: ${text.replace(/[.!?]+$/u, "")}.` : "";

/** Cuts at a word boundary where one is near, marks the cut with an ellipsis. */
function shorten(text: string, max: number) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const word = cut.lastIndexOf(" ");
  return `${(word >= max / 2 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

/**
 * Fits the avoid list into `room` characters: every entry is shortened to the
 * same share, none below 24 characters; entries from the end are dropped
 * only when even that does not fit.
 */
function fitAvoid(entries: string[], room: number): string[] {
  const overhead = "Avoid: .".length;
  const total = (list: string[]) =>
    overhead +
    list.reduce((sum, entry) => sum + entry.length, 0) +
    2 * Math.max(0, list.length - 1);
  if (total(entries) <= room) return entries;
  const share = (list: string[]) =>
    Math.floor((room - overhead - 2 * (list.length - 1)) / list.length);
  let list = entries;
  while (list.length && share(list) < 24) list = list.slice(0, -1);
  return list.map((entry) => shorten(entry, share(list)));
}

function correctionText(correction: ArtCorrection, area: string) {
  const change = {
    subject_larger:
      "Correction: make the main subject larger and more dominant, about 70 to 75 percent of the frame, shown closer, with less empty space around it.",
    calm_text_zone: `Correction: make the ${area} of the image calmer, smooth and soft with low contrast and no objects or detail, so text can be placed there.`,
    more_detail:
      "Correction: add more relevant detail and texture around the subject and fill any large plain or empty areas with the scene's surroundings.",
  }[correction.kind];
  const note = correction.note ? oneLine(correction.note, 300) : "";
  return note ? `${change} Finding: ${note.replace(/[.!?]+$/u, "")}.` : change;
}

/**
 * The provider prompt for a creative's artwork (spec §7), at most 4000
 * characters: one large, concrete subject in the brand's imagery style and
 * palette, a calm area where the layout puts the text, and the fixed negatives
 * last. Only profile and brief text goes in, flattened to single lines; the
 * product name stays out because a model may draw it. When the avoid list does
 * not fit, its entries are shortened (never the fixed rules). `correction`
 * adds the change a failed art check asks for.
 */
export function artPrompt(
  brief: ResolvedBrief,
  profile: MarketingProfile,
  correction?: ArtCorrection,
): string {
  const identity = profile.visualIdentity;
  const imagery = identity.imagery;
  const showsProduct =
    brief.imageKind === "product" || brief.imageKind === "combined";
  const zone = placement(
    brief.reservedZones[0],
    showsProduct ? brief.reservedZones[2] : undefined,
  );
  const mood = oneLine(brief.mood, 300);
  const brandMood = oneLine(imagery?.mood ?? "", 300);
  const word = (hex: string) => {
    const name = colourWord(hex);
    return name ? `${name} (${hex})` : hex;
  };

  const lines = [
    `Create one finished marketing image. ${
      imagery
        ? `Imagery kind: ${imagery.kind}, ${IMAGERY_STYLE[imagery.kind]}.`
        : "Style: polished, modern and professional."
    }`,
    sentence("Main subject", oneLine(brief.motif, 300)),
    sentence("Setting", oneLine(brief.setting, 300)),
    sentence(
      "Mood and lighting",
      [mood, brandMood && brandMood !== mood ? `brand mood: ${brandMood}` : ""]
        .filter(Boolean)
        .join("; "),
    ),
    sentence(
      "Typical subjects of the brand",
      oneLine(imagery?.subjects ?? "", 500),
    ),
    [
      "Compose a bold hero image: one clear main subject, shown large and close, in sharp focus, with a strong simple silhouette and clear contrast against its surroundings.",
      "The main subject fills about 60 to 75 percent of the frame.",
      zone.sentence,
      "Outside that calm area give the scene depth with a foreground, a midground and a softly blurred background, and fill it with relevant detail instead of empty space.",
    ].join(" "),
    ...(correction ? [correctionText(correction, zone.area)] : []),
    ...(showsProduct
      ? [
          "This is the setting for a real product screenshot added later; do not show any device screen content.",
        ]
      : []),
    `Brand palette: ${word(identity.primaryColor)}, ${word(identity.secondaryColor)}, accent ${word(identity.accentColor)}; base tone ${word(identity.backgroundColor)}. Use these hues for the subject, props and light.`,
  ].filter(Boolean);

  const avoid = [
    ...new Set(
      [
        ...brief.avoid,
        ...(imagery?.avoid ?? []),
        ...(identity.forbiddenDesigns ?? []),
      ]
        .map((entry) => oneLine(entry, 300))
        .filter(Boolean),
    ),
  ];
  const fixed = [...lines, ART_NEGATIVES].join("\n");
  const kept = fitAvoid(avoid, MAX_PROMPT - fixed.length - 1);
  return [
    ...lines,
    ...(kept.length ? [`Avoid: ${kept.join("; ")}.`] : []),
    ART_NEGATIVES,
  ].join("\n");
}
