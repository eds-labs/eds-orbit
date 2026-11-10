import { describe, expect, it } from "vitest";
import { BURST, READS_PER_MINUTE, readPacer } from "./read-pacing";

const SPACING = 60_000 / READS_PER_MINUTE;
// Simulated clocks start late, like Date.now(), so the first reads get the
// burst.
const START = 3_600_000;

// A browser test waits for a page's reads before its next step: a simulated
// navigation issues its reads together and ends when the last one leaves.
function navigate(pacer: ReturnType<typeof readPacer>, at: number, reads = 1) {
  let done = at;
  for (let i = 0; i < reads; i++) done = Math.max(done, at + pacer.wait(at));
  return done;
}

describe("browser read pacing", () => {
  it("lets no more than the rate and the burst into any minute", () => {
    const pacer = readPacer();
    const sent: number[] = [];
    let now = START;
    // Bursts of different sizes and gaps, issued without waiting.
    for (let i = 0; i < 400; i++) {
      for (let j = 0; j < (i % 7) * 9; j++) sent.push(now + pacer.wait(now));
      now += (i % 5) * 250;
    }
    sent.sort((a, b) => a - b);
    let most = 0;
    // The server counts whole milliseconds; the spacing is a fraction of one.
    for (let i = 0, first = 0; i < sent.length; i++) {
      while (sent[first]! <= sent[i]! - 60_000 + 0.5) first++;
      most = Math.max(most, i - first + 1);
    }
    expect(most).toBe(READS_PER_MINUTE + BURST);
  });

  it("holds a navigation's reads for each other, not for the minute before", () => {
    // The flaky acceptance runs: one test opened every page in quick
    // succession, the next clicked through the settings, and a read waited
    // for the first test's reads to leave a rolling window, longer than the
    // 15 s an assertion waits.
    const pacer = readPacer();
    let now = START,
      longest = 0;
    for (const [pages, reads] of [
      [25, 16],
      [12, 14],
    ] as const)
      for (let i = 0; i < pages; i++) {
        const done = navigate(pacer, now, reads);
        longest = Math.max(longest, done - now);
        now = done + 300;
      }
    // At most one spacing per read of the navigation.
    expect(longest).toBeLessThanOrEqual(16 * SPACING);
  });

  it("gives an aborted read's slot to the next read", () => {
    const pacer = readPacer();
    navigate(pacer, START, BURST + 10);
    const queued = pacer.wait(START);
    expect(queued).toBeGreaterThan(0);
    pacer.refund();
    expect(pacer.wait(START)).toBe(queued);
  });
});
