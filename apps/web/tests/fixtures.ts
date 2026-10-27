import { test as base, type Route } from "@playwright/test";

export * from "@playwright/test";

// The API allows 600 reads per minute and client address
// (apps/api/src/server.ts). On a fast machine the suite's page loads exceed
// that, and a refused read fails whichever test is running. Browser reads to
// the API therefore wait for room below 500 per rolling minute; the server
// limit itself stays in force. Workers run the files one after another, so
// this window spans every file of a worker.
const READS_PER_MINUTE = 500;
const WINDOW_MS = 60_000;
const sent: number[] = [];

async function room() {
  for (;;) {
    const now = Date.now();
    while (sent.length && sent[0]! <= now - WINDOW_MS) sent.shift();
    if (sent.length < READS_PER_MINUTE) {
      sent.push(now);
      return;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, sent[0]! + WINDOW_MS - now),
    );
  }
}

async function paceRead(route: Route) {
  if (["GET", "HEAD"].includes(route.request().method())) await room();
  await route.fallback();
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await context.route((url) => url.pathname.startsWith("/api/"), paceRead);
    await use(context);
  },
});
