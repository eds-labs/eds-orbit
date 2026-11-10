/** Detects credential-shaped text (private keys, provider tokens, assigned secrets). */
export function containsCredentials(text: string) {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})|(?:api[_-]?key|password|client[_-]?secret|access[_-]?token)\s*[:=]\s*["'][^"']{8,}["']/i.test(
    text,
  );
}
