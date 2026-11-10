// The schedule behind the browser tests' read pacing (fixtures.ts), kept pure
// so it can be tested without a browser.
//
// Reads leave at a steady READS_PER_MINUTE with a burst of BURST (a token
// bucket, kept as the next free slot). No minute then holds more than
// READS_PER_MINUTE + BURST reads, and a read waits only for the reads queued
// before it, one spacing each, whatever came before.
export const READS_PER_MINUTE = 450;
export const BURST = 50;

export function readPacer(perMinute = READS_PER_MINUTE, burst = BURST) {
  const spacing = 60_000 / perMinute;
  let nextSlot = 0;
  return {
    /** The wait in ms before a read issued at `now` may leave. */
    wait(now: number) {
      const slot = Math.max(nextSlot, now - burst * spacing);
      nextSlot = slot + spacing;
      return Math.max(0, slot - now);
    },
    /** Gives back the slot of a read that never reached the API. */
    refund() {
      nextSlot -= spacing;
    },
  };
}
