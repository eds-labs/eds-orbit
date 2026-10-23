import { AsyncLocalStorage } from "node:async_hooks";

// Better Auth hands a new password-reset token to `sendResetPassword`. The
// Orbit route that requested it runs the request inside `withResetCapture`
// and receives the token here, so it can mail the link or (for an
// administrator without system mail) show it once. Outside such a call the
// token is dropped: nothing else can request a reset.
const store = new AsyncLocalStorage<{ token?: string }>();

export function captureResetToken(token: string) {
  const slot = store.getStore();
  if (slot) slot.token = token;
}

/** Runs `fn` and returns the reset token Better Auth issued during it. */
export async function withResetCapture(
  fn: () => Promise<unknown>,
): Promise<string | undefined> {
  const slot: { token?: string } = {};
  await store.run(slot, fn);
  return slot.token;
}
