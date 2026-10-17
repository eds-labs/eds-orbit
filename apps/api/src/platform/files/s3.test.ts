import { describe, expect, it } from "vitest";
import { amzDate, s3Store, signS3Request } from "./s3.ts";

// The example from the AWS documentation "Signature Calculations for the
// Authorization Header: Transferring Payload in a Single Chunk", GET Object.
const EXAMPLE = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  now: new Date("2013-05-24T00:00:00Z"),
};
const EMPTY =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("S3 Signature Version 4 (WP4.6)", () => {
  it("matches the documented AWS example", () => {
    const headers = signS3Request({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { Range: "bytes=0-9" },
      payloadHash: EMPTY,
      ...EXAMPLE,
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(amzDate(EXAMPLE.now)).toBe("20130524T000000Z");
  });

  it("refuses plain http outside localhost and keys it did not generate", async () => {
    const config = {
      bucket: "b",
      region: "auto",
      accessKeyId: "k",
      secretAccessKey: "s",
    };
    expect(() =>
      s3Store({ ...config, endpoint: "http://r2.example.com" }),
    ).toThrow("OBJECT_STORE_ENDPOINT_INSECURE");
    const store = s3Store(
      { ...config, endpoint: "https://r2.example.com" },
      { fetch: async () => new Response(null, { status: 200 }) },
    );
    await expect(store.get("../other")).rejects.toThrow("OBJECT_KEY_INVALID");
    await expect(store.get("a//b")).rejects.toThrow("OBJECT_KEY_INVALID");
  });

  it("maps answers: 404 is null on read and fine on delete, 403 is an auth error", async () => {
    let status = 404;
    const store = s3Store(
      {
        endpoint: "https://r2.example.com",
        bucket: "b",
        region: "auto",
        accessKeyId: "k",
        secretAccessKey: "s",
      },
      { fetch: async () => new Response(null, { status }) },
    );
    expect(await store.get("projects/p/f")).toBeNull();
    await store.delete("projects/p/f");
    status = 403;
    await expect(
      store.put("projects/p/f", new Uint8Array([1])),
    ).rejects.toMatchObject({
      code: "OBJECT_STORE_AUTH",
      status: 403,
    });
  });
});
