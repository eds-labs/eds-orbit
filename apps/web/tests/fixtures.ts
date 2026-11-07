import { test as base, type Route } from "@playwright/test";
import { readPacer } from "./read-pacing";

export * from "@playwright/test";

// The API allows 600 reads per minute and client address
// (apps/api/src/server.ts). On a fast machine the suite's page loads exceed
// that, and a refused read fails whichever test is running. Browser reads to
// the API therefore keep to at most 500 per minute (read-pacing.ts); the
// server limit itself stays in force. Workers run the files one after
// another, so the pacing spans every file of a worker.
const nextRead = readPacer();

async function paceRead(route: Route) {
  if (["GET", "HEAD"].includes(route.request().method())) {
    const wait = nextRead(Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  }
  await route.fallback();
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await context.route((url) => url.pathname.startsWith("/api/"), paceRead);
    await use(context);
  },
});
