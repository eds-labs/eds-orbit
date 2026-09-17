import type { NextRequest } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const hopHeaders = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
];
async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await context.params;
    if (
      path.some(
        (segment) =>
          segment === "." || segment === ".." || segment.includes("\0"),
      )
    )
      return Response.json(
        { error: { code: "INVALID_PATH", message: "Invalid API path." } },
        { status: 400 },
      );
    const target = new URL(
      process.env.ORBIT_API_ORIGIN || "http://127.0.0.1:4311",
    );
    if (
      !["http:", "https:"].includes(target.protocol) ||
      target.username ||
      target.password
    )
      throw new Error("Invalid upstream configuration");
    target.pathname = `/api/${path.map((segment) => encodeURIComponent(segment)).join("/")}`;
    target.search = request.nextUrl.search;
    const headers = new Headers();
    for (const name of [
      "accept",
      "content-type",
      "cookie",
      "origin",
      "user-agent",
      "x-csrf-token",
      "x-slack-signature",
      "x-slack-request-timestamp",
    ]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      duplex: "half",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(45000)]),
    } as RequestInit & { duplex: "half" });
    const returned = new Headers(upstream.headers);
    for (const name of hopHeaders) returned.delete(name);
    returned.delete("set-cookie");
    for (const cookie of upstream.headers.getSetCookie())
      returned.append("set-cookie", cookie);
    returned.set("Cache-Control", "no-store, max-age=0");
    returned.set("X-Content-Type-Options", "nosniff");
    return new Response(upstream.body, {
      status: upstream.status,
      headers: returned,
    });
  } catch {
    return Response.json(
      {
        error: {
          code: "API_UNAVAILABLE",
          message: "The workspace service is unavailable. Try again shortly.",
        },
      },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
export {
  proxy as GET,
  proxy as POST,
  proxy as PATCH,
  proxy as PUT,
  proxy as DELETE,
  proxy as OPTIONS,
  proxy as HEAD,
};
