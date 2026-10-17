import { createHash } from "node:crypto";
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

  // The same page's PUT Object example: a signed body hash, extra signed
  // headers and a key character ("$") that must be percent-encoded.
  it("matches the documented PUT example with a body and a special character", () => {
    const body = "Welcome to Amazon S3.";
    const headers = signS3Request({
      method: "PUT",
      url: new URL("https://examplebucket.s3.amazonaws.com/test$file.text"),
      headers: {
        Date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      },
      payloadHash: createHash("sha256").update(body).digest("hex"),
      ...EXAMPLE,
    });
    expect(headers["x-amz-content-sha256"]).toBe(
      "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
    );
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });

  it("matches the documented query-string examples (lifecycle, list objects)", () => {
    const sign = (url: string) =>
      signS3Request({
        method: "GET",
        url: new URL(url),
        headers: {},
        payloadHash: EMPTY,
        ...EXAMPLE,
      }).authorization;
    expect(sign("https://examplebucket.s3.amazonaws.com/?lifecycle")).toMatch(
      /Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543$/,
    );
    // Parameters arrive unsorted; the canonical query sorts them.
    expect(
      sign("https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2"),
    ).toMatch(
      /Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/,
    );
  });

  it("sends what it signed: the body's hash, length and type", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const store = s3Store(
      {
        endpoint: "https://r2.example.com/",
        bucket: "orbit-files",
        region: "auto",
        accessKeyId: "k",
        secretAccessKey: "s",
      },
      {
        fetch: async (url, init) => {
          sent.push({ url, init });
          return new Response(null, { status: 200 });
        },
        now: () => EXAMPLE.now,
      },
    );
    const body = new Uint8Array([1, 2, 3]);
    await store.put("projects/p/m/f", body);
    const [{ url, init }] = sent as [{ url: string; init: RequestInit }];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe("https://r2.example.com/orbit-files/projects/p/m/f");
    expect(init.redirect).toBe("error");
    expect(headers["x-amz-content-sha256"]).toBe(
      createHash("sha256").update(body).digest("hex"),
    );
    expect(headers.authorization).toContain(
      "SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date,",
    );
    // fetch sets the length itself; it must be the signed one.
    expect(Buffer.from(init.body as Uint8Array).byteLength).toBe(3);
    expect(headers.host).toBeUndefined();
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
