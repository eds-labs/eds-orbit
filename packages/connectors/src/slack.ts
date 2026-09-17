import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ConnectorError, jsonTransport, type FetchLike } from './http.ts';
export type SlackSignedRequest = { rawBody: string | Buffer; timestamp: string; signature: string; signingSecret: string; now?: number };
export function verifySlackRequest(input: SlackSignedRequest) {
  const now = input.now ?? Date.now();
  if (!input.signingSecret || !/^\d{10}$/.test(input.timestamp) || !/^v0=[a-f0-9]{64}$/.test(input.signature) || Math.abs(now / 1000 - Number(input.timestamp)) > 300 || Buffer.byteLength(input.rawBody) > 1_048_576) throw new ConnectorError('SLACK_SIGNATURE_INVALID', 'rejected');
  const expected = 'v0=' + createHmac('sha256', input.signingSecret).update(`v0:${input.timestamp}:`).update(input.rawBody).digest('hex');
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(input.signature))) throw new ConnectorError('SLACK_SIGNATURE_INVALID', 'rejected');
  return { fingerprint: createHash('sha256').update(input.signature).digest('hex'), expiresAt: new Date((Number(input.timestamp) + 300) * 1000) };
}
export type SlackInteraction = { teamId: string; slackUserId: string; actionId: string; value: string; fingerprint: string; channelId?: string };
/** claimReplay must be an atomic, durable unique insert, scoped to this Slack app. */
export async function verifySlackInteraction(input: SlackSignedRequest, controls: { expectedTeamId: string; expectedChannelId?: string; claimReplay: (fingerprint: string, expiresAt: Date) => Promise<boolean>; authorize: (interaction: SlackInteraction) => Promise<boolean> }): Promise<SlackInteraction> {
  const verified = verifySlackRequest(input);
  let payload: unknown;
  try { payload = JSON.parse(new URLSearchParams(input.rawBody.toString()).get('payload') ?? ''); } catch { throw new ConnectorError('SLACK_PAYLOAD_INVALID', 'rejected'); }
  const p = payload as { type?: string; team?: { id?: string }; channel?: { id?: string }; user?: { id?: string }; actions?: { action_id?: string; value?: string }[] };
  if (!p || p.type !== 'block_actions' || p.team?.id !== controls.expectedTeamId || controls.expectedChannelId !== undefined && p.channel?.id !== controls.expectedChannelId || typeof p.user?.id !== 'string' || !/^[A-Z0-9]{2,40}$/.test(p.user.id) || p.actions?.length !== 1 || typeof p.actions[0]?.action_id !== 'string' || p.actions[0].action_id.length > 100 || typeof p.actions[0]?.value !== 'string' || !p.actions[0].value || p.actions[0].value.length > 2000) throw new ConnectorError('SLACK_PAYLOAD_INVALID', 'rejected');
  const interaction = { teamId: p.team.id, slackUserId: p.user.id, actionId: p.actions[0].action_id, value: p.actions[0].value, fingerprint: verified.fingerprint, channelId: p.channel?.id };
  if (!await controls.authorize(interaction)) throw new ConnectorError('SLACK_ACTOR_UNAUTHORIZED', 'rejected');
  if (!await controls.claimReplay(verified.fingerprint, verified.expiresAt)) throw new ConnectorError('SLACK_REPLAY', 'rejected');
  return interaction;
}

export type SlackMessagePayload = { channel: string; text: string; blocks?: Record<string, unknown>[] };
/** Fixed Slack endpoint. Authorization/mandate and durable intent belong to the server executor. */
export function createSlackClient(options: { token: string; fetch?: FetchLike }) {
  if (!/^xoxb-[A-Za-z0-9-]{10,500}$/.test(options.token)) throw new ConnectorError('INVALID_SLACK_TOKEN');
  const call = jsonTransport({ baseUrl: 'https://slack.com/api/', token: `Bearer ${options.token}`, fetch: options.fetch });
  return {
    async postMessage(input: SlackMessagePayload) {
      if (!/^[CG][A-Z0-9]{2,39}$/.test(input.channel) || !input.text.trim() || input.text.length > 4000 || (input.blocks?.length ?? 0) > 40 || JSON.stringify(input).length > 40_000) throw new ConnectorError('INVALID_SLACK_MESSAGE');
      const result = await call('chat.postMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, mrkdwn: false, parse: 'none', unfurl_links: false, unfurl_media: false }) }, true);
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) throw new ConnectorError('SLACK_MESSAGE_REJECTED', 'rejected');
      const receipt = z.object({ ok: z.literal(true), channel: z.string(), ts: z.string().regex(/^\d+\.\d+$/) }).safeParse(result);
      if (!receipt.success || receipt.data.channel !== input.channel) throw new ConnectorError('INVALID_SLACK_RECEIPT', 'unknown');
      return { state: 'sent' as const, channel: receipt.data.channel, ts: receipt.data.ts };
    },
  };
}
