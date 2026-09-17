import { createHash } from 'node:crypto';
import { ConnectorError } from './http.ts';
import { assertMediaBytes } from './media.ts';
export type BlogArticle = { title: string; slug: string; language: string; bodyMarkdown: string; description: string; updatedAt: string; sourceUrls: string[]; assets?: { filename: string; mime: 'image/png' | 'image/jpeg' | 'image/webp'; bytes: Uint8Array; alt: string }[] };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Portable draft bundle. It makes no CMS/publication request. Preview is escaped text, never executable Markdown. */
export function exportBlogArticle(article: BlogArticle) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug) || article.slug.length > 120 || !article.title.trim() || article.title.length > 240 || article.bodyMarkdown.length > 250_000 || article.description.length > 500 || !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(article.language) || Number.isNaN(Date.parse(article.updatedAt)) || article.sourceUrls.length > 100) throw new ConnectorError('INVALID_ARTICLE');
  for (const source of article.sourceUrls) { let url: URL; try { url = new URL(source); } catch { throw new ConnectorError('INVALID_SOURCE_URL'); } if (url.protocol !== 'https:' || url.username || url.password) throw new ConnectorError('INVALID_SOURCE_URL'); }
  const files: { path: string; mime: string; content: string; encoding: 'utf8' | 'base64'; sha256: string }[] = [];
  const add = (path: string, mime: string, bytes: Buffer, encoding: 'utf8' | 'base64' = 'utf8') => files.push({ path, mime, content: bytes.toString(encoding), encoding, sha256: createHash('sha256').update(bytes).digest('hex') });
  const names = new Set<string>();
  for (const asset of article.assets ?? []) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\.(png|jpg|jpeg|webp)$/.test(asset.filename) || names.has(asset.filename) || asset.bytes.length === 0 || asset.bytes.length > 10 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime) || asset.alt.length > 500) throw new ConnectorError('INVALID_BLOG_ASSET');
    assertMediaBytes(asset.bytes, asset.mime, 10 * 1024 * 1024);
    const expectedExt = asset.mime === 'image/png' ? /\.png$/i : asset.mime === 'image/jpeg' ? /\.jpe?g$/i : /\.webp$/i;
    if (!expectedExt.test(asset.filename)) throw new ConnectorError('BLOG_ASSET_EXTENSION_MISMATCH');
    names.add(asset.filename); add(`assets/${asset.filename}`, asset.mime, Buffer.from(asset.bytes), 'base64');
  }
  if (files.reduce((n, f) => n + f.content.length, 0) > 30 * 1024 * 1024) throw new ConnectorError('ARTICLE_ASSETS_TOO_LARGE');
  const metadata = { title: article.title, slug: article.slug, language: article.language, description: article.description, updatedAt: article.updatedAt, sourceUrls: article.sourceUrls, status: 'draft', assets: (article.assets ?? []).map(a => ({ path: `assets/${a.filename}`, alt: a.alt, mime: a.mime })) };
  add('article.md', 'text/markdown', Buffer.from(article.bodyMarkdown));
  add('metadata.json', 'application/json', Buffer.from(JSON.stringify(metadata, null, 2)));
  const preview = `<!doctype html><html lang="${article.language}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(article.title)}</title><style>body{font:18px/1.7 system-ui;max-width:760px;margin:48px auto;padding:24px;color:#122d40;background:#f7fbff}pre{white-space:pre-wrap;font:inherit;overflow-wrap:anywhere}</style></head><body><p>Export draft · ${escapeHtml(article.updatedAt)}</p><h1>${escapeHtml(article.title)}</h1><p>${escapeHtml(article.description)}</p><pre>${escapeHtml(article.bodyMarkdown)}</pre></body></html>`;
  add('preview.html', 'text/html', Buffer.from(preview));
  return { format: 'orbit-blog-bundle-v1' as const, state: 'export_ready' as const, liveAdapter: 'not_configured' as const, article: metadata, files, contentHash: createHash('sha256').update(JSON.stringify(files.map(f => [f.path, f.sha256]))).digest('hex') };
}
