import { test as base, type Request, type Route } from "@playwright/test";

export * from "@playwright/test";

// The API allows 600 reads per minute and client address
// (apps/api/src/server.ts). On a fast machine the suite's page loads exceed
// that, and a refused read fails whichever test is running. Browser reads to
// the API therefore leave at a steady rate with a small burst; the server
// limit itself stays in force.
//
// A cap per rolling minute does not work here: a fast test used the whole
// budget in 17 s, and the next page's first read then waited 43 s for the
// window to pass, far beyond the 15 s of every expectation, so the page stayed
// on "Loading workspace…". At a steady rate a read waits about as long as the
// reads queued before it. Each worker paces on its own and a failed test
// starts a new worker, so the rate and the burst stay well below the limit.
const READS_PER_MINUTE = 450;
const BURST = 50;
const SPACING_MS = 60_000 / READS_PER_MINUTE;
let nextSlot = 0;

async function readSlot() {
  const now = Date.now();
  const slot = Math.max(nextSlot, now - BURST * SPACING_MS);
  nextSlot = slot + SPACING_MS;
  if (slot > now)
    await new Promise((resolve) => setTimeout(resolve, slot - now));
}

const isRead = (request: Request) =>
  ["GET", "HEAD"].includes(request.method());

async function paceRead(route: Route) {
  if (isRead(route.request())) await readSlot();
  await route.fallback();
}

// A read aborted in the browser does not reach the API, so it costs nothing.
// `next dev` aborts many: React Strict Mode mounts every effect twice, and a
// navigation cancels the page's open reads (287 of 731 reads in one run).
function refundAbortedRead(request: Request) {
  if (isRead(request) && new URL(request.url()).pathname.startsWith("/api/"))
    nextSlot -= SPACING_MS;
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await context.route((url) => url.pathname.startsWith("/api/"), paceRead);
    context.on("requestfailed", refundAbortedRead);
    await use(context);
  },
});
