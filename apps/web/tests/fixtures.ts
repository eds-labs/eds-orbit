import { test as base, type Request, type Route } from "@playwright/test";
import { readPacer } from "./read-pacing";

export * from "@playwright/test";

// The API allows 600 reads per minute and client address
// (apps/api/src/server.ts). On a fast machine the suite's page loads exceed
// that, and a refused read fails whichever test is running. Browser reads to
// the API therefore leave at a steady rate with a small burst
// (read-pacing.ts); the server limit itself stays in force.
//
// A cap per rolling minute does not work here: a fast test used the whole
// budget in 17 s, and the next page's first read then waited 43 s for the
// window to pass, far beyond the 15 s of every expectation, so the page stayed
// on "Loading workspace…". At a steady rate a read waits about as long as the
// reads queued before it. Each worker paces on its own and a failed test
// starts a new worker, so the rate and the burst stay well below the limit.
const pacer = readPacer();

const isRead = (request: Request) =>
  ["GET", "HEAD"].includes(request.method());

async function paceRead(route: Route) {
  if (isRead(route.request())) {
    const wait = pacer.wait(Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  }
  await route.fallback();
}

// A read aborted in the browser does not reach the API, so it costs nothing.
// `next dev` aborts many: React Strict Mode mounts every effect twice, and a
// navigation cancels the page's open reads (287 of 731 reads in one run).
function refundAbortedRead(request: Request) {
  if (isRead(request) && new URL(request.url()).pathname.startsWith("/api/"))
    pacer.refund();
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await context.route((url) => url.pathname.startsWith("/api/"), paceRead);
    context.on("requestfailed", refundAbortedRead);
    await use(context);
  },
});
