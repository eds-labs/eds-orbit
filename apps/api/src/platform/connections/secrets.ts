import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { DomainError, decrypt, encrypt } from "../shared.ts";

// The master-key ring for central connection secrets (ADR 0013). New
// secrets use the first CREDENTIAL_KEYS entry, or CREDENTIAL_KEY as key id
// "default"; every listed key stays readable, so the master key can be
// rotated by re-encrypting secrets under a newer id.

function ring() {
  const c = loadConfig();
  const keys = new Map<string, string>([["default", c.CREDENTIAL_KEY]]);
  const listed = (c.CREDENTIAL_KEYS ?? "")
    .split(",")
    .filter(Boolean)
    .map((entry) => entry.split(":") as [string, string]);
  for (const [id, key] of listed) keys.set(id, key);
  return { keys, current: listed[0]?.[0] ?? "default" };
}

/** Encrypts a plain secret with the current master key. */
export function sealSecret(plain: string) {
  const { keys, current } = ring();
  return { keyId: current, ciphertext: encrypt(plain, keys.get(current)!) };
}

/** Decrypts a stored secret; never log or return the result. */
export function openSecret(stored: { keyId: string; ciphertext: string }) {
  const key = ring().keys.get(stored.keyId);
  if (!key) throw new DomainError("CREDENTIAL_KEY_UNKNOWN", 500);
  return decrypt(stored.ciphertext, key);
}
