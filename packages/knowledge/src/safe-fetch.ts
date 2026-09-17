import { Resolver, type lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, request } from "node:https";
import { KnowledgeError, LIMITS } from "./types.js";
export type FetchPolicy = {
  allowedOrigins: string[];
  allowedPaths: string[];
  maxBytes?: number;
  timeoutMs?: number;
};
export function isPublicAddress(input: string): boolean {
  const value = input.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(value) === 4) {
    const p = value.split(".").map(Number),
      a = p[0]!,
      b = p[1]!,
      c = p[2]!;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 &&
        (b === 168 || b === 0 || b === 2 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(value) !== 6) return false;
  // Permit native global unicast only; reject mapped IPv4, local, multicast and transition ranges.
  const leading = Number.parseInt(value.split(":")[0]!, 16);
  if (!Number.isFinite(leading) || leading < 0x2000 || leading > 0x3fff)
    return false;
  const second = Number.parseInt(value.split(":")[1] || "0", 16);
  if (
    (leading === 0x2001 && (second < 0x200 || second === 0xdb8)) ||
    leading === 0x2002 ||
    leading >= 0x3ffe
  )
    return false;
  return true;
}
export function validatePublicUrl(input: string, policy: FetchPolicy): URL {
  if (input.length > 8000) throw new KnowledgeError("URL_NOT_ALLOWED");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new KnowledgeError("INVALID_URL");
  }
  if (
    url.protocol !== "https:" ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new KnowledgeError("URL_NOT_ALLOWED");
  if (!policy.allowedOrigins.includes(url.origin))
    throw new KnowledgeError("ORIGIN_NOT_ALLOWED");
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    throw new KnowledgeError("PATH_NOT_ALLOWED");
  }
  if (
    path.includes("\\") ||
    /%(?:2e|2f|5c)/i.test(path) ||
    path.split("/").includes("..")
  )
    throw new KnowledgeError("PATH_NOT_ALLOWED");
  if (
    !policy.allowedPaths.some(
      (prefix) =>
        prefix.startsWith("/") &&
        (prefix === "/" ||
          path === prefix ||
          path.startsWith(prefix.endsWith("/") ? prefix : prefix + "/")),
    )
  )
    throw new KnowledgeError("PATH_NOT_ALLOWED");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host))
    throw new KnowledgeError("PRIVATE_ADDRESS");
  return url;
}
export async function resolvePublic(
  host: string,
  resolve?: typeof lookup,
  timeoutMs = 5000,
) {
  const family = isIP(host);
  if (family) {
    if (!isPublicAddress(host)) throw new KnowledgeError("PRIVATE_ADDRESS");
    return [{ address: host, family }];
  }
  const resolver = new Resolver({
    timeout: Math.min(timeoutMs, 5000),
    tries: 1,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const operation = resolve
      ? resolve(host, { all: true, verbatim: true })
      : Promise.allSettled([
          resolver.resolve4(host),
          resolver.resolve6(host),
        ]).then((results) =>
          results.flatMap((result, index) =>
            result.status === "fulfilled"
              ? result.value.map((address) => ({
                  address,
                  family: index === 0 ? 4 : 6,
                }))
              : [],
          ),
        );
    const addresses = await Promise.race([
      operation,
      new Promise<never>((_ok, reject) => {
        timer = setTimeout(() => {
          resolver.cancel();
          reject(new KnowledgeError("SOURCE_TIMEOUT"));
        }, timeoutMs);
        timer.unref();
      }),
    ]);
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
      throw new KnowledgeError("PRIVATE_ADDRESS");
    return addresses;
  } finally {
    if (timer) clearTimeout(timer);
    resolver.cancel();
  }
}
export async function fetchPublicDocument(input: string, policy: FetchPolicy) {
  const url = validatePublicUrl(input, policy),
    host = url.hostname.replace(/^\[|\]$/g, "");
  const maxBytes = Math.min(
      policy.maxBytes ?? LIMITS.maxBytes,
      LIMITS.maxBytes,
    ),
    timeoutMs = Math.min(policy.timeoutMs ?? 10000, 20000),
    deadlineAt = Date.now() + timeoutMs;
  const addresses = await resolvePublic(host, undefined, timeoutMs),
    selected = addresses[0]!,
    remainingMs = Math.max(1, deadlineAt - Date.now());
  return new Promise<{
    bytes: Buffer;
    mimeType: string;
    url: string;
    etag: string | null;
  }>((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        agent: new Agent({ keepAlive: false }),
        family: selected.family,
        headers: {
          "user-agent": "EDS-Orbit-Knowledge/1.0",
          accept:
            "text/html,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "accept-encoding": "identity",
        },
        lookup: (_hostname, _options, callback) =>
          callback(null, selected.address, selected.family),
        timeout: remainingMs,
      },
      (res) => {
        const fail = (code: string) => {
          res.destroy();
          reject(new KnowledgeError(code));
        };
        // No redirects: avoids cross-origin, path or metadata redirection bypasses.
        if (res.statusCode !== 200) {
          fail(
            res.statusCode && res.statusCode >= 300 && res.statusCode < 400
              ? "REDIRECT_NOT_ALLOWED"
              : res.statusCode === 401 || res.statusCode === 403
                ? "SOURCE_ACCESS_DENIED"
                : res.statusCode === 404 || res.statusCode === 410
                  ? "SOURCE_NOT_FOUND"
                  : "SOURCE_FETCH_FAILED",
          );
          return;
        }
        if (
          res.headers["content-encoding"] &&
          res.headers["content-encoding"] !== "identity"
        ) {
          fail("COMPRESSED_RESPONSE_NOT_ALLOWED");
          return;
        }
        const mimeType = String(res.headers["content-type"] ?? "")
          .split(";")[0]!
          .trim()
          .toLowerCase();
        if (
          ![
            "text/html",
            "text/plain",
            "text/markdown",
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          ].includes(mimeType)
        ) {
          fail("UNSUPPORTED_MIME");
          return;
        }
        if (Number(res.headers["content-length"] ?? 0) > maxBytes) {
          fail("DOCUMENT_TOO_LARGE");
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) fail("DOCUMENT_TOO_LARGE");
          else chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            bytes: Buffer.concat(chunks),
            mimeType,
            url: url.toString(),
            etag:
              typeof res.headers.etag === "string" ? res.headers.etag : null,
          }),
        );
        res.on("error", () =>
          reject(new KnowledgeError("SOURCE_FETCH_FAILED")),
        );
      },
    );
    const deadline = setTimeout(() => {
      req.destroy();
      reject(new KnowledgeError("SOURCE_TIMEOUT"));
    }, remainingMs);
    deadline.unref();
    req.on("close", () => clearTimeout(deadline));
    req.on("timeout", () => {
      req.destroy();
      reject(new KnowledgeError("SOURCE_TIMEOUT"));
    });
    req.on("error", () => reject(new KnowledgeError("SOURCE_FETCH_FAILED")));
    req.end();
  });
}
export function robotsPathMatches(
  pattern: string,
  target: string,
  anchored: boolean,
  budget = { remaining: 100000 },
) {
  if (pattern.length > 2000 || target.length > 8000)
    throw new KnowledgeError("ROBOTS_LIMIT");
  let p = 0,
    t = 0,
    star = -1,
    retry = 0;
  while (t < target.length) {
    if (--budget.remaining < 0) throw new KnowledgeError("ROBOTS_LIMIT");
    if (p === pattern.length && !anchored) return true;
    if (pattern[p] === target[t]) {
      p++;
      t++;
    } else if (pattern[p] === "*") {
      star = p++;
      retry = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++retry;
    } else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}
export function robotsAllows(
  text: string,
  url: URL,
  userAgent = "eds-orbit-knowledge",
) {
  if (Buffer.byteLength(text) > 256000)
    throw new KnowledgeError("ROBOTS_LIMIT");
  const groups: Array<{
    agents: string[];
    rules: Array<{ allow: boolean; path: string }>;
  }> = [];
  let group:
    | { agents: string[]; rules: Array<{ allow: boolean; path: string }> }
    | undefined;
  for (const original of text.split(/\r?\n/)) {
    const line = original.split("#")[0]!.trim(),
      colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase(),
      value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!group || group.rules.length) {
        group = { agents: [], rules: [] };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if (
      group &&
      (key === "allow" || key === "disallow") &&
      value &&
      value.length <= 2000
    )
      group.rules.push({ allow: key === "allow", path: value });
  }
  const specific = groups.filter((g) =>
    g.agents.some((a) => a !== "*" && userAgent.startsWith(a)),
  );
  const active = specific.length
    ? specific
    : groups.filter((g) => g.agents.includes("*"));
  const budget = { remaining: 250000 };
  let best: { allow: boolean; length: number } | undefined;
  let target = url.pathname + url.search;
  try {
    target = decodeURI(target);
  } catch {
    /* Keep encoded path when malformed. */
  }
  for (const g of active)
    for (const rule of g.rules) {
      const anchored = rule.path.endsWith("$");
      let path = anchored ? rule.path.slice(0, -1) : rule.path;
      try {
        path = decodeURI(path);
      } catch {
        /* Conservative encoded comparison. */
      }
      if (robotsPathMatches(path, target, anchored, budget)) {
        const length = path.replace(/\*/g, "").length;
        if (
          !best ||
          length > best.length ||
          (length === best.length && rule.allow)
        )
          best = { allow: rule.allow, length };
      }
    }
  return best?.allow ?? true;
}
export async function fetchApprovedDocument(
  input: string,
  policy: FetchPolicy,
) {
  const url = validatePublicUrl(input, policy);
  try {
    const robots = await fetchPublicDocument(url.origin + "/robots.txt", {
      ...policy,
      allowedPaths: ["/robots.txt"],
      maxBytes: 256000,
    });
    if (!robotsAllows(robots.bytes.toString("utf8"), url))
      throw new KnowledgeError("ROBOTS_DISALLOWED");
  } catch (e) {
    if (!(e instanceof KnowledgeError && e.code === "SOURCE_NOT_FOUND"))
      throw e;
  }
  return fetchPublicDocument(input, policy);
}
/** Extract bounded public page references only; no XML entities, DTDs, subrequests or recursion. */
export function discoverPublicPages(
  xml: string,
  policy: FetchPolicy,
  maxPages = 100,
) {
  if (!Number.isInteger(maxPages) || maxPages < 1)
    throw new KnowledgeError("INVALID_PAGE_LIMIT");
  if (
    Buffer.byteLength(xml) > LIMITS.maxBytes ||
    /<!DOCTYPE|<!ENTITY/i.test(xml)
  )
    throw new KnowledgeError("UNSAFE_DISCOVERY_DOCUMENT");
  const candidates = [
    ...xml.matchAll(/<loc(?:\s[^>]*)?>\s*([^<]+)\s*<\/loc>/gi),
  ].map((m) => m[1]!);
  candidates.push(
    ...[...xml.matchAll(/<link(?:\s[^>]*)?>\s*([^<]+)\s*<\/link>/gi)].map(
      (m) => m[1]!,
    ),
  );
  candidates.push(
    ...[
      ...xml.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi),
    ].map((m) => m[1]!),
  );
  const urls = new Set<string>();
  for (const candidate of candidates) {
    try {
      const u = validatePublicUrl(
        candidate.trim().replace(/&amp;/g, "&"),
        policy,
      );
      urls.add(u.toString());
      if (urls.size >= Math.min(maxPages, 100)) break;
    } catch {
      /* Outside approved scope never enters the crawl plan. */
    }
  }
  return [...urls];
}
