import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptFile, encryptFile } from "./crypto.ts";

const KEY = randomBytes(32).toString("hex");
const ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";

describe("file encryption (WP4.6)", () => {
  it("round-trips with a fresh IV each time", () => {
    const plain = randomBytes(1000);
    const a = encryptFile(plain, ID, KEY);
    const b = encryptFile(plain, ID, KEY);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(Buffer.from(decryptFile(a, ID, KEY)).equals(plain)).toBe(true);
  });

  it("refuses another key, another file id and any changed byte", () => {
    const sealed = Buffer.from(encryptFile(Buffer.from("secret"), ID, KEY));
    expect(() =>
      decryptFile(sealed, ID, randomBytes(32).toString("hex")),
    ).toThrow("FILE_INTEGRITY");
    expect(() =>
      decryptFile(sealed, "00000000-0000-4000-8000-000000000000", KEY),
    ).toThrow("FILE_INTEGRITY");
    for (const at of [0, 5, sealed.length - 1]) {
      const changed = Buffer.from(sealed);
      changed[at] = changed[at]! ^ 1;
      expect(() => decryptFile(changed, ID, KEY)).toThrow("FILE_INTEGRITY");
    }
    expect(() => decryptFile(sealed.subarray(0, 10), ID, KEY)).toThrow(
      "FILE_INTEGRITY",
    );
  });
});
