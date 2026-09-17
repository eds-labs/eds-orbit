import { lookup } from 'node:dns/promises';
import { Agent, request } from 'node:https';
import ipaddr from 'ipaddr.js';

export type ConnectorOutcome = 'not_sent' | 'rejected' | 'unknown';
export class ConnectorError extends Error {
  constructor(public code: string, public outcome: ConnectorOutcome = 'not_sent', public retryable = false, public status?: number) {
    super(code); this.name = 'ConnectorError';
  }
}
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;
export type HttpOptions = { baseUrl: string; token: string; fetch?: FetchLike; timeoutMs?: number };

export function endpoint(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new ConnectorError('INVALID_ENDPOINT'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new ConnectorError('INVALID_ENDPOINT');
  return url;
}
function publicAddress(address: string): boolean {
  try { let ip = ipaddr.parse(address); if (ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress()) ip = (ip as ipaddr.IPv6).toIPv4Address(); return ip.range() === 'unicast'; } catch { return false; }
}

/** HTTPS transport pins a checked DNS address. No redirects, private ranges or unbounded response bodies. */
export const boundedFetch: FetchLike = async (input, init = {}) => {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password) throw new ConnectorError('INVALID_ENDPOINT');
  if (init.signal?.aborted) throw new ConnectorError('REQUEST_TIMEOUT', 'not_sent', true);
  const addresses = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    let finished = false;
    const stop = () => { if (finished) return; finished = true; clearTimeout(timer); init.signal?.removeEventListener('abort', stop); reject(new ConnectorError('DNS_TIMEOUT', 'not_sent', true)); };
    const timer = setTimeout(stop, 15_000);
    init.signal?.addEventListener('abort', stop, { once: true });
    void lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true, verbatim: true }).then(result => {
      if (finished) return; finished = true; clearTimeout(timer); init.signal?.removeEventListener('abort', stop); resolve(result);
    }, () => { if (finished) return; finished = true; clearTimeout(timer); init.signal?.removeEventListener('abort', stop); reject(new ConnectorError('DNS_FAILED', 'not_sent', true)); });
  });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new ConnectorError('PRIVATE_ENDPOINT');
  const prepared = new Request(url, { ...init, redirect: 'manual' });
  const payload = init.body ? Buffer.from(await prepared.arrayBuffer()) : undefined;
  if (payload && payload.byteLength > 40 * 1024 * 1024) throw new ConnectorError('REQUEST_TOO_LARGE');
  return new Promise<Response>((resolve, reject) => {
    const address = addresses[0]!;
    let finished = false;
    const done = (error?: Error, response?: Response) => { if (finished) return; finished = true; clearTimeout(timer); init.signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(response!); };
    const req = request(url, {
      method: prepared.method, agent: new Agent({ keepAlive: false }), headers: Object.fromEntries(prepared.headers),
      lookup: (_hostname, options, callback) => {
        // Node's family autoselection requests all=true and expects an address array.
        const done = callback as (error: NodeJS.ErrnoException | null, value: string | { address: string; family: number }[], family?: number) => void;
        if (options.all) done(null, [address]); else done(null, address.address, address.family);
      },
    }, res => {
      const chunks: Buffer[] = []; let bytes = 0;
      res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { req.destroy(); done(new ConnectorError('RESPONSE_TOO_LARGE', prepared.method === 'GET' ? 'not_sent' : 'unknown')); } else chunks.push(chunk); });
      res.on('error', () => done(new ConnectorError('NETWORK_ERROR', prepared.method === 'GET' ? 'not_sent' : 'unknown', prepared.method === 'GET')));
      res.on('end', () => { const headers = new Headers(); for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v); const status = res.statusCode ?? 502; done(undefined, new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers })); });
    });
    const abort = () => { req.destroy(); done(new ConnectorError('REQUEST_TIMEOUT', prepared.method === 'GET' ? 'not_sent' : 'unknown', prepared.method === 'GET')); };
    const timer = setTimeout(abort, 30_000);
    req.on('error', () => done(new ConnectorError('NETWORK_ERROR', prepared.method === 'GET' ? 'not_sent' : 'unknown', prepared.method === 'GET')));
    if (init.signal?.aborted) { abort(); return; }
    init.signal?.addEventListener('abort', abort, { once: true });
    req.end(payload);
  });
};

export function jsonTransport(options: HttpOptions) {
  const base = endpoint(options.baseUrl); if (!base.pathname.endsWith('/')) base.pathname += '/';
  if (!options.token || /[\r\n]/.test(options.token)) throw new ConnectorError('INVALID_CREDENTIAL');
  const fetcher = options.fetch ?? boundedFetch;
  return async (path: string, init: RequestInit = {}, sideEffect = false): Promise<unknown> => {
    const url = new URL(path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new ConnectorError('INVALID_PATH');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.min(30_000, options.timeoutMs ?? 15_000));
    try {
      const response = await fetcher(url, { ...init, redirect: 'manual', signal: controller.signal, headers: { Authorization: options.token, Accept: 'application/json', ...Object.fromEntries(new Headers(init.headers)) } });
      if (!response.ok) {
        const ambiguous = sideEffect && (response.status >= 500 || response.status === 408 || (response.status >= 300 && response.status < 400));
        throw new ConnectorError(response.status === 401 || response.status === 403 ? 'PROVIDER_AUTH' : response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_REJECTED', ambiguous ? 'unknown' : 'rejected', !ambiguous && (response.status === 429 || response.status >= 500), response.status);
      }
      const contentLength = Number(response.headers.get('content-length'));
      if (contentLength > 2 * 1024 * 1024) throw new ConnectorError('RESPONSE_TOO_LARGE', sideEffect ? 'unknown' : 'rejected');
      const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let total = 0;
      if (reader) for (;;) { const { value, done } = await reader.read(); if (done) break; total += value.length; if (total > 2 * 1024 * 1024) { await reader.cancel(); throw new ConnectorError('RESPONSE_TOO_LARGE', sideEffect ? 'unknown' : 'rejected'); } chunks.push(value); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new ConnectorError('INVALID_PROVIDER_RESPONSE', sideEffect ? 'unknown' : 'rejected'); }
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError('NETWORK_ERROR', sideEffect ? 'unknown' : 'not_sent', !sideEffect);
    } finally { clearTimeout(timer); }
  };
}
