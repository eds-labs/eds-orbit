import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// File contents are encrypted before they leave Orbit (WP4.6): AES-256-GCM
// with a fresh 96-bit IV per file and the file id as additional data, so an
// object copied onto another row does not decrypt. Layout: version (1 byte),
// IV (12), ciphertext, tag (16).

export const FILE_ENCRYPTION = "aes-256-gcm/v1";
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const keyOf = (hex: string) => {
  if (!/^[a-fA-F0-9]{64}$/.test(hex)) throw new Error("FILES_KEY_INVALID");
  return Buffer.from(hex, "hex");
};

export function encryptFile(
  plain: Uint8Array,
  fileId: string,
  keyHex: string,
): Uint8Array {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyOf(keyHex), iv);
  cipher.setAAD(Buffer.from(fileId));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, body, cipher.getAuthTag()]);
}

/** Throws FILE_INTEGRITY for a wrong key, another file's object or any change. */
export function decryptFile(
  sealed: Uint8Array,
  fileId: string,
  keyHex: string,
): Uint8Array {
  const data = Buffer.from(sealed);
  if (data.length < 1 + IV_BYTES + TAG_BYTES || data[0] !== VERSION)
    throw new Error("FILE_INTEGRITY");
  const iv = data.subarray(1, 1 + IV_BYTES);
  const tag = data.subarray(data.length - TAG_BYTES);
  const body = data.subarray(1 + IV_BYTES, data.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyOf(keyHex), iv);
    decipher.setAAD(Buffer.from(fileId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new Error("FILE_INTEGRITY");
  }
}
