// A tab change can navigate (the knowledge tabs are pages of their own). The
// page under the optional catch-all route remounts on every navigation, so the
// tab bar is rebuilt and the focused tab is removed: the focus falls to
// <body>. The bar remembers which tab the user moved to; the next mount of the
// same bar (same tab keys) with that tab active focuses it again.
let pending: { bar: string; key: string } | undefined;

/** Identifies a tab bar by its tab keys, so another bar never takes the focus. */
export function tabBarId(keys: readonly string[]) {
  return JSON.stringify(keys);
}

/** The user moved to `key` in `bar`; a remounted bar may restore the focus. */
export function rememberTabFocus(bar: string, key: string) {
  pending = { bar, key };
}

/** The bar kept its place (no remount): nothing is left to restore. */
export function forgetTabFocus(bar: string) {
  if (pending?.bar === bar) pending = undefined;
}

/**
 * Whether a mounting `bar` with `value` active should focus that tab. Any
 * mount of the same bar consumes the remembered tab, matching or not.
 */
export function takeTabFocus(bar: string, value: string) {
  if (pending?.bar !== bar) return false;
  const restore = pending.key === value;
  pending = undefined;
  return restore;
}
