import { describe, expect, it } from 'vitest';
import { renderTemplate, renderRasterTemplate, templateFormats } from './index.ts';
describe('deterministic original-brand renderer', () => {
  it.each(Object.keys(templateFormats) as (keyof typeof templateFormats)[])('renders %s with expected size, unchanged logo and safe margin', format => {
    const input = { format, logoApproved: true, title: 'Plan with evidence', subtitle: 'Review every source before publishing.', cta: 'Explore the workspace' };
    const a = renderTemplate(input), b = renderTemplate(input);
    expect(a.status).toBe('rendered'); if (a.status !== 'rendered') return;
    expect(a.contentHash).toBe(b.status === 'rendered' ? b.contentHash : ''); expect([a.width, a.height]).toEqual(templateFormats[format]); expect(a.logoHash).toBe('a652f47968922890004e279004986a01ec968ffead1f3fb1a70af5c3e37f423c'); expect(a.svg).toContain('data:image/svg+xml;base64,'); expect(a.safeMargin).toBeGreaterThan(80);
  });
  it('blocks overflow instead of truncating or exporting clipped text', () => {
    expect(() => renderTemplate({ format: 'landscape', logoApproved: true, title: 'Extremely long title '.repeat(20) })).toThrow('TEXT_OVERFLOW');
  });
  it('escapes script and produces a brief when the source logo is unapproved', () => {
    const rendered = renderTemplate({ format: 'square', logoApproved: true, title: '<script> bad </script>' }); expect(rendered.status === 'rendered' && rendered.svg).not.toContain('<script>');
    expect(renderTemplate({ format: 'square', title: 'Hello', logoApproved: false })).toMatchObject({ status: 'blocked_asset', creativeBrief: { requiredAsset: 'Approved original project logo' } });
  });
});

describe('bounded PNG export', () => {
  it('fails closed for omitted brand approval before rasterization', async () => {
    expect(renderTemplate({ format: 'square', title: 'Hello' })).toMatchObject({ status: 'blocked_asset' });
    expect(await renderRasterTemplate({ format: 'square', title: 'Hello' })).toMatchObject({ status: 'blocked_asset' });
  });
  it.each(Object.keys(templateFormats) as (keyof typeof templateFormats)[])('exports real PNG pixels for %s', async format => {
    const output = await renderRasterTemplate({ format, title: 'Evidence first', logoApproved: true });
    expect(output.status).toBe('rendered');
    if (output.status !== 'rendered') return;
    expect(output.mime).toBe('image/png');
    expect(output.bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect([output.bytes.readUInt32BE(16), output.bytes.readUInt32BE(20)]).toEqual(templateFormats[format]);
    expect(output.bytes.length).toBeGreaterThan(1000);
    expect(output.sourceSvgHash).toHaveLength(64);
    expect(output.logoHash).toBe('a652f47968922890004e279004986a01ec968ffead1f3fb1a70af5c3e37f423c');
    expect(output.renderer.version).toBe('0.35.4');
  });
});
