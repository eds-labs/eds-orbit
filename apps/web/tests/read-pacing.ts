// The schedule behind the browser tests' read pacing (fixtures.ts), kept pure
// so it can be tested without a browser.
//
// A read may go once it is at most BURST reads ahead of a steady rate of
// READS_PER_MINUTE (a token bucket, kept as the time the next read is due).
// No minute then holds more than READS_PER_MINUTE + BURST reads, and a read
// waits only for the reads queued before it: a navigation's reads go within
// one interval (125 ms) each, whatever came before.
//
// A rolling window of 500 reads instead held the 501st read until the oldest
// left the window. After a fast burst of page loads that was a single wait of
// up to a minute, wherever the window filled, longer than the 15 s an
// assertion waits (the shell then stayed on "Loading workspace…").
export const READS_PER_MINUTE = 480;
export const BURST = 20;

/** Returns the wait in ms before a read issued at `now` may go. */
export function readPacer(perMinute = READS_PER_MINUTE, burst = BURST) {
  const interval = 60_000 / perMinute;
  let due = -Infinity;
  return (now: number) => {
    due = Math.max(due, now - burst * interval);
    const wait = Math.max(0, due - now);
    due += interval;
    return wait;
  };
}
