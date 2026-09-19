import { z } from 'zod';
import { assertMediaBytes } from './media.ts';
import { ConnectorError, jsonTransport, type HttpOptions } from './http.ts';
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const media = z.object({ id, path: z.url().refine(s => new URL(s).protocol === 'https:', 'HTTPS required') });
const createSchema = z.object({
  type: z.enum(['draft', 'schedule', 'now']), date: z.iso.datetime(), shortLink: z.boolean().default(false),
  tags: z.array(z.object({ id, value: z.string().max(100) }).strict()).max(20).default([]),
  posts: z.array(z.object({ integration: z.object({ id }).strict(), value: z.array(z.object({ content: z.string().min(1).max(50_000), image: z.array(media).max(10).default([]) }).strict()).min(1).max(20), settings: z.record(z.string(), z.unknown()).refine(v => typeof v.__type === 'string' && /^[a-z][a-z0-9-]{0,50}$/.test(v.__type)) }).strict()).min(1).max(10),
}).strict();
export type PostizCreateInput = z.input<typeof createSchema>;
const integrationSchema = z.object({ id, name: z.string(), identifier: z.string(), disabled: z.boolean(), profile: z.string().nullable().optional() });
const remoteSchema = z.object({ id, state: z.string(), publishDate: z.string(), integration: z.object({ id, providerIdentifier: z.string().optional() }), releaseURL: z.string().nullable().optional() });
export type PostizPost = z.infer<typeof remoteSchema>;
function validated<T>(schema: z.ZodType<T>, value: unknown, written = false): T { const result = schema.safeParse(value); if (!result.success) throw new ConnectorError('INVALID_PROVIDER_RESPONSE', written ? 'unknown' : 'rejected'); return result.data; }
function validId(value: string) { if (!id.safeParse(value).success) throw new ConnectorError('INVALID_REMOTE_ID'); return value; }
export const postizCapabilities = { listIntegrations: true, readStatusByDateRange: true, createDraft: true, schedule: true, publishNow: true, uploadMedia: true, delete: 'whole_group', reschedule: false, providerIdempotency: false, receiptProvesPublication: false } as const;

/** Call writes only from an executor that just checked the complete action package. */
export function createPostizClient(options: HttpOptions) {
  const call = jsonTransport(options);
  async function listPosts(range: { startDate: string; endDate: string }) {
    if (!z.iso.datetime().safeParse(range.startDate).success || !z.iso.datetime().safeParse(range.endDate).success || Date.parse(range.endDate) < Date.parse(range.startDate) || Date.parse(range.endDate) - Date.parse(range.startDate) > 32 * 86400_000) throw new ConnectorError('INVALID_DATE_RANGE');
    const result = await call(`posts?${new URLSearchParams(range)}`);
    return validated(z.object({ posts: z.array(remoteSchema).max(10_000) }), result).posts;
  }
  return {
    capabilities: postizCapabilities,
    async listIntegrations() { return validated(z.array(integrationSchema).max(1_000), await call('integrations/')); },
    async healthcheck() { await validated(z.array(integrationSchema), await call('integrations/')); return { status: 'read_verified' as const, checkedAt: new Date().toISOString() }; },
    async createPost(input: PostizCreateInput) {
      const parsed = createSchema.safeParse(input); if (!parsed.success) throw new ConnectorError('INVALID_POST_PAYLOAD');
      if (parsed.data.type === 'schedule' && Date.parse(parsed.data.date) <= Date.now()) throw new ConnectorError('SCHEDULE_IN_PAST');
      if (JSON.stringify(parsed.data).length > 500_000) throw new ConnectorError('POST_TOO_LARGE');
      const result = validated(z.array(z.object({ postId: id, integration: id })).min(1), await call('posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed.data) }, true), true);
      const expected = parsed.data.posts.map(x => x.integration.id);
      if (result.length !== expected.length || result.some(x => !expected.includes(x.integration)) || new Set(result.map(x => x.postId)).size !== result.length || new Set(result.map(x => x.integration)).size !== new Set(expected).size) throw new ConnectorError('INCOMPLETE_WRITE_RECEIPT', 'unknown');
      return { remotePosts: result, state: 'accepted' as const, requestedType: parsed.data.type };
    },
    listPosts,
    async findPostStatus(remoteId: string, range: { startDate: string; endDate: string }) {
      validId(remoteId); const post = (await listPosts(range)).find(p => p.id === remoteId);
      return post ? { found: true as const, post } : { found: false as const, state: 'outcome_unknown' as const };
    },
    async deletePost(remoteId: string, acknowledgement: { allowGroupDelete: true }) {
      validId(remoteId); if (acknowledgement?.allowGroupDelete !== true) throw new ConnectorError('GROUP_DELETE_ACK_REQUIRED');
      const result = validated(z.object({ id }), await call(`posts/${encodeURIComponent(remoteId)}`, { method: 'DELETE' }, true), true);
      return { remoteId: result.id, state: 'deletion_acknowledged' as const, scope: 'whole_group' as const };
    },
    async uploadMedia(file: { bytes: Uint8Array; mime: string; filename: string }) {
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'video/mp4'].includes(file.mime) || file.bytes.length === 0 || file.bytes.length > 20 * 1024 * 1024 || !/^[A-Za-z0-9_.-]{1,160}$/.test(file.filename)) throw new ConnectorError('INVALID_MEDIA');
      assertMediaBytes(file.bytes, file.mime);
      const form = new FormData(); form.set('file', new Blob([Uint8Array.from(file.bytes)], { type: file.mime }), file.filename);
      return validated(media, await call('upload', { method: 'POST', body: form }, true), true);
    },
  };
}
