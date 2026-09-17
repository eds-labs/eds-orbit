import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const logo = readFileSync(new URL('../assets/logo-layer-stack-mark.svg', import.meta.url));
const logoHash = createHash('sha256').update(logo).digest('hex');
const manifest = JSON.parse(readFileSync(new URL('../assets/manifest.json', import.meta.url), 'utf8')) as { sha256: string };
if (logoHash !== manifest.sha256) throw new Error('BRAND_ASSET_INTEGRITY_FAILED');
export const templateFormats = { square: [1080, 1080], landscape: [1200, 630], portrait: [1080, 1350], story: [1080, 1920] } as const;
export type TemplateInput = { format: keyof typeof templateFormats; title: string; subtitle?: string; cta?: string; brandName?: string; logoApproved?: boolean };
export class CreativeError extends Error { constructor(public code: string) { super(code); this.name = 'CreativeError'; } }
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
function width(text: string, size: number) { return Array.from(text).reduce((n, char) => n + (/\s/u.test(char) ? .45 : /[ilI.,'!|]/u.test(char) ? .4 : /[MW@#%]/u.test(char) ? 1.1 : (char.codePointAt(0) ?? 0) > 255 ? 1.3 : .85) * size, 0); }
function wrap(text: string, maxWidth: number, size: number, maxLines: number) {
  const lines: string[] = []; let line = '';
  for (const word of text.trim().split(/\s+/u)) {
    if (width(word, size) > maxWidth) throw new CreativeError('TEXT_OVERFLOW');
    const next = line ? line + ' ' + word : word;
    if (width(next, size) > maxWidth) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) throw new CreativeError('TEXT_OVERFLOW');
  return lines;
}
/** Fixed, bounded template rendering; no generated logo or font download. */
export function renderTemplate(input: TemplateInput) {
  if (!Object.hasOwn(templateFormats, input.format) || !input.title.trim() || input.title.length > 500 || (input.subtitle?.length ?? 0) > 500 || (input.cta?.length ?? 0) > 80 || (input.brandName?.length ?? 0) > 80 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(input.title + (input.subtitle ?? '') + (input.cta ?? '') + (input.brandName ?? ''))) throw new CreativeError('INVALID_TEMPLATE_INPUT');
  if (input.logoApproved !== true) return { status: 'blocked_asset' as const, creativeBrief: { format: input.format, title: input.title, subtitle: input.subtitle ?? '', requiredAsset: 'Approved original project logo', nextStep: 'Approve a source asset before rendering an export.' } };
  const [w, h] = templateFormats[input.format]; const margin = Math.round(w * .08); const textWidth = w - 2 * margin;
  const landscape = input.format === 'landscape'; const titleSize = landscape ? 54 : 64; const bodySize = landscape ? 26 : 32;
  const titleLines = wrap(input.title, textWidth, titleSize, landscape ? 3 : 6);
  const bodyLines = input.subtitle?.trim() ? wrap(input.subtitle, textWidth, bodySize, landscape ? 2 : 4) : [];
  const cta = input.cta?.trim() ?? ''; if (width(cta, 26) > textWidth - 48) throw new CreativeError('TEXT_OVERFLOW');
  const brand = input.brandName ?? 'EDS Labs'; if (width(brand, 25) > textWidth - 128) throw new CreativeError('TEXT_OVERFLOW');
  const titleY = landscape ? 240 : Math.round(h * .31);
  const titleHeight = titleLines.length * titleSize * 1.18;
  const bodyY = titleY + titleHeight + 24;
  const bodyBottom = bodyY + bodyLines.length * bodySize * 1.45;
  const ctaY = h - margin - 62;
  if ((bodyLines.length ? bodyBottom : titleY + titleHeight) > (cta ? ctaY - 32 : h - margin)) throw new CreativeError('TEXT_OVERFLOW');
  const textLines = (lines: string[], y: number, size: number, lineHeight: number, color: string, weight: number) => `<text x="${margin}" y="${y}" fill="${color}" font-size="${size}" font-weight="${weight}" font-family="DejaVu Sans, Arial, sans-serif">${lines.map((line, i) => `<tspan x="${margin}" dy="${i ? lineHeight : 0}">${escape(line)}</tspan>`).join('')}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="title desc"><title id="title">${escape(input.title)}</title><desc id="desc">${escape(input.subtitle ?? '')}</desc><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#F6FBFF"/><stop offset="1" stop-color="#DDF4FF"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#bg)"/><rect x="${margin / 2}" y="${margin / 2}" width="${w - margin}" height="${h - margin}" rx="32" fill="#FFFFFF" fill-opacity=".6" stroke="#B6DDF3"/><image x="${margin}" y="${margin}" width="96" height="96" href="data:image/svg+xml;base64,${logo.toString('base64')}"/><text x="${margin + 120}" y="${margin + 60}" fill="#10273D" font-family="DejaVu Sans,Arial,sans-serif" font-size="25" font-weight="700">${escape(brand)}</text>${textLines(titleLines, titleY, titleSize, titleSize * 1.18, '#071522', 700)}${textLines(bodyLines, bodyY, bodySize, bodySize * 1.45, '#254D66', 400)}${cta ? `<rect x="${margin}" y="${ctaY}" width="${Math.ceil(width(cta, 26)) + 48}" height="62" rx="16" fill="#0969FF"/><text x="${margin + 24}" y="${ctaY + 40}" fill="#FFFFFF" font-family="DejaVu Sans,Arial,sans-serif" font-size="26" font-weight="700">${escape(cta)}</text>` : ''}</svg>`;
  return { status: 'rendered' as const, filename: `creative-${input.format}.svg`, mime: 'image/svg+xml' as const, svg, width: w, height: h, safeMargin: margin, contentHash: createHash('sha256').update(svg).digest('hex'), logoHash, overflowChecked: true, format: input.format, note: 'SVG export. Raster conversion and provider format acceptance are separate gates; no platform upload was performed.' };
}

/** Rasterizes only our fixed template, never arbitrary SVG, remote URLs, or user markup. */
export async function renderRasterTemplate(input: TemplateInput) {
  const rendered = renderTemplate(input);
  if (rendered.status !== 'rendered') return rendered;
  const { default: sharp } = await import('sharp');
  try {
    const output = await sharp(Buffer.from(rendered.svg), {
      density: 72,
      limitInputPixels: 1080 * 1920,
      failOn: 'warning',
      animated: false,
    }).timeout({ seconds: 10 }).png({ compressionLevel: 9, adaptiveFiltering: false, palette: false }).toBuffer({ resolveWithObject: true });
    if (output.info.width !== rendered.width || output.info.height !== rendered.height || output.info.format !== 'png' || output.data.length > 20 * 1024 * 1024) throw new CreativeError('RASTER_OUTPUT_INVALID');
    return {
      ...rendered,
      filename: `creative-${input.format}.png`,
      mime: 'image/png' as const,
      bytes: output.data,
      sourceSvgHash: rendered.contentHash,
      contentHash: createHash('sha256').update(output.data).digest('hex'),
      renderer: { name: 'sharp', version: sharp.versions.sharp, libvips: sharp.versions.vips },
      note: 'Local PNG export with the original logo. Platform-specific crop and live upload acceptance remain unverified; raster bytes may vary by installed fonts and renderer version.',
    };
  } catch (error) {
    if (error instanceof CreativeError) throw error;
    throw new CreativeError('RASTER_RENDER_FAILED');
  }
}
