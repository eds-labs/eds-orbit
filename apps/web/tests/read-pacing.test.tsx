import { describe, expect, it } from "vitest";
import { readPacer } from "./read-pacing";

// A browser test waits for a page's reads before its next step: a simulated
// navigation issues its reads together and ends when the last one goes.
function navigate(pace: (now: number) => number, at: number, reads: number) {
  let done = at;
  for (let i = 0; i < reads; i++) done = Math.max(done, at + pace(at));
  return done;
}

describe("browser read pacing", () => {
  it("lets no more than 500 reads into any minute", () => {
    const pace = readPacer();
    const sent: number[] = [];
    let now = 0;
    // Bursts of different sizes and gaps, issued without waiting.
    for (let i = 0; i < 400; i++) {
      for (let j = 0; j < (i % 7) * 9; j++) sent.push(now + pace(now));
      now += (i % 5) * 250;
    }
    sent.sort((a, b) => a - b);
    let most = 0;
    for (let i = 0, first = 0; i < sent.length; i++) {
      while (sent[first]! <= sent[i]! - 60_000) first++;
      most = Math.max(most, i - first + 1);
    }
    expect(most).toBe(500);
  });

  it("holds a navigation's reads for each other, not for the minute before", () => {
    // The flaky acceptance runs: one test opened every page in quick
    // succession, the next clicked through the settings, and a read waited
    // for the first test's reads to leave the window, longer than the 15 s
    // an assertion waits.
    const pace = readPacer();
    let now = 0,
      longest = 0;
    for (const [pages, reads] of [
      [25, 16],
      [12, 14],
    ] as const)
      for (let i = 0; i < pages; i++) {
        const done = navigate(pace, now, reads);
        longest = Math.max(longest, done - now);
        now = done + 300;
      }
    // At most one steady interval (125 ms) per read of the navigation.
    expect(longest).toBeLessThanOrEqual(16 * 125);
  });
});
