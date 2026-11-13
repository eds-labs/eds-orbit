// Shared by the notification bell and the attention list: both follow
// links that the API stored, so both apply the same character check.

/**
 * Only Orbit paths are followed: a notice never sends a member elsewhere.
 * No backslash, space or control character, since browsers read "/\\x" and
 * "/<tab>/x" as "//x" (the API's ORBIT_PATH rule).
 */
export function safeLink(link: string | null) {
  return link && /^\/(?![/\\])[^\s\\\u0000-\u001f\u007f]*$/.test(link)
    ? link
    : null;
}
