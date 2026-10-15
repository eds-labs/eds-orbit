import { BlockList, isIP } from "node:net";
import type { FastifyRequest } from "fastify";

// The web proxy (apps/web/src/app/api/[...path]/route.ts) sends the browser's
// address in this header. Fastify keeps trustProxy off, so req.ip is always
// the TCP peer, and the header is believed only from a peer on loopback or a
// private network.
//
// Trust assumption: the API is published on no host port and reachable only
// over the internal Compose networks, so every private-network peer is an
// Orbit container (in production the web proxy). A public peer cannot choose
// its rate-limit bucket. A compromised internal container could, but it can
// already call the API directly.
export const CLIENT_IP_HEADER = "x-orbit-client-ip";

const trustedPeers = new BlockList();
trustedPeers.addSubnet("127.0.0.0", 8, "ipv4");
trustedPeers.addSubnet("10.0.0.0", 8, "ipv4");
trustedPeers.addSubnet("172.16.0.0", 12, "ipv4");
trustedPeers.addSubnet("192.168.0.0", 16, "ipv4");
trustedPeers.addAddress("::1", "ipv6");
trustedPeers.addSubnet("fc00::", 7, "ipv6");

// "::ffff:10.0.0.5" and "10.0.0.5" are the same client and the same bucket.
function normalize(address: string) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return (mapped ? mapped[1]! : address).toLowerCase();
}

function trustedPeer(address: string) {
  const family = isIP(address);
  return (
    family !== 0 && trustedPeers.check(address, family === 4 ? "ipv4" : "ipv6")
  );
}

/**
 * The client address used for rate limiting: the forwarded header from a
 * trusted peer when it holds one valid IP, otherwise the TCP peer itself.
 */
export function clientIp(req: FastifyRequest) {
  const peer = normalize(req.socket.remoteAddress ?? req.ip);
  const forwarded = req.headers[CLIENT_IP_HEADER];
  if (typeof forwarded !== "string" || !trustedPeer(peer)) return peer;
  const value = normalize(forwarded.trim());
  return isIP(value) ? value : peer;
}

/**
 * Overwrites the header with the resolved address, so Better Auth (which reads
 * only this header, see auth.ts) sees the same client as the rate limiter and
 * never a value a direct caller made up.
 */
export function pinClientIpHeader(req: FastifyRequest) {
  req.headers[CLIENT_IP_HEADER] = clientIp(req);
}
