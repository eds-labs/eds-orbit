import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { boundedFetch, providerDetail } from './http.ts';
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:https', async importOriginal => ({ ...await importOriginal<typeof import('node:https')>(), request: vi.fn() }));

describe('providerDetail redaction', () => {
  it.each([
    ['plain text', 'Invalid Bearer EAAB123abc for this app', 'Invalid [redacted] for this app'],
    ['JSON message', JSON.stringify({ message: 'Authorization: bearer EAAB123abc rejected' }), 'Authorization: [redacted] rejected'],
    ['upper case and repeated spaces', 'BEARER   EAAB123abc', '[redacted]'],
    ['newline separator', 'Bearer\nEAAB123abc denied', '[redacted] denied'],
    ['several tokens', 'Bearer EAAB123abc and Bearer EAAB456def', '[redacted] and [redacted]'],
  ])('removes the credential after a bearer scheme: %s', async (_name, body, expected) => {
    expect(await providerDetail(new Response(body, { status: 401 }))).toBe(expected);
  });

  it.each([
    ['bearer with no value', 'Missing bearer', 'Missing [redacted]'],
    ['other keywords keep the following words', 'token expired at noon', '[redacted] expired at noon'],
    ['keyword suffix without whitespace', 'bad api_key=abc123 sent', 'bad api_[redacted] sent'],
  ])('keeps the keyword redaction unchanged: %s', async (_name, body, expected) => {
    expect(await providerDetail(new Response(body, { status: 400 }))).toBe(expected);
  });
});

describe('pinned native HTTPS transport', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.useRealTimers());
  it('answers both Node DNS callback shapes using the single prechecked IP', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
    let nativeOptions: { lookup: (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => void } | undefined;
    vi.mocked(request).mockImplementation(((url: URL, options: typeof nativeOptions, listener: (response: EventEmitter & { headers: Record<string, string>; statusCode: number }) => void) => {
      nativeOptions = options;
      const req = Object.assign(new EventEmitter(), {
        end: () => queueMicrotask(() => {
          const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': 'application/json' } });
          listener(response); response.emit('data', Buffer.from('{}')); response.emit('end');
        }),
        destroy: () => undefined,
      });
      return req;
    }) as never);
    expect(await (await boundedFetch('https://provider.example/')).json()).toEqual({});
    const single = vi.fn(), all = vi.fn();
    nativeOptions!.lookup('untrusted-second-answer.example', {}, single);
    nativeOptions!.lookup('untrusted-second-answer.example', { all: true }, all);
    expect(single).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    expect(all).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it('aborts hung DNS before constructing or sending an HTTP request', async () => {
    vi.mocked(lookup).mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const result = boundedFetch('https://provider.example/', { signal: controller.signal, method: 'POST', body: '{}' });
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'DNS_TIMEOUT', outcome: 'not_sent' });
    expect(request).not.toHaveBeenCalled();
  });
  it('bounds DNS even when the caller provides no signal', async () => {
    vi.useFakeTimers();
    vi.mocked(lookup).mockImplementation(() => new Promise(() => {}));
    const result = expect(boundedFetch('https://provider.example/')).rejects.toMatchObject({ code: 'DNS_TIMEOUT', outcome: 'not_sent' });
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(request).not.toHaveBeenCalled();
  });
});
