import { describe, expect, it } from "vitest";
import { validateCimdMetadata } from "@better-auth/cimd";

const id = "https://client.test/client.json";
const key = {
  kty: "OKP",
  crv: "Ed25519",
  x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
  alg: "EdDSA",
  use: "sig",
};
const document = {
  client_id: id,
  client_name: "Synthetic client",
  redirect_uris: ["https://client.test/cb"],
  token_endpoint_auth_method: "private_key_jwt",
  jwks: { keys: [key] },
};
describe("CIMD authentication-method list backport", () => {
  it.each([[], ["client_secret_basic"], "none", [42], Array(17).fill("none")])(
    "rejects an unusable or malformed list: %j",
    (methods) => {
      expect(
        validateCimdMetadata(id, {
          ...document,
          token_endpoint_auth_methods_supported: methods,
        }).valid,
      ).toBe(false);
    },
  );
  it("rejects a preference outside the offered set and signing without keys", () => {
    expect(
      validateCimdMetadata(id, {
        ...document,
        token_endpoint_auth_methods_supported: ["none"],
      }).valid,
    ).toBe(false);
    expect(
      validateCimdMetadata(id, {
        ...document,
        jwks: undefined,
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      }).valid,
    ).toBe(false);
  });
  it("filters unsupported alternatives and retains the declared supported methods", () => {
    const result = validateCimdMetadata(id, {
      ...document,
      token_endpoint_auth_methods_supported: [
        "future_method",
        "none",
        "private_key_jwt",
      ],
    });
    expect(result.valid).toBe(true);
    if (result.valid)
      expect(result.metadata).toMatchObject({
        token_endpoint_auth_method: "private_key_jwt",
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      });
  });
  it("does not interpret a nested metadata extension as a capability declaration", () => {
    const result = validateCimdMetadata(id, {
      ...document,
      metadata: { token_endpoint_auth_methods_supported: ["none"] },
    });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.metadata).not.toHaveProperty("metadata");
  });
});
