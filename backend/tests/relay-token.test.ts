// Unit tests for the relay-token encryption-at-rest module (lib/relay-token.ts):
// seal/open round trip, the shape dispatch between ciphertext and legacy
// plaintext (tokens are any `\S+`, so a plaintext may contain `:`), and the
// named error a stored value that does not open throws.
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  isRelayTokenCiphertext,
  openRelayToken,
  RelayTokenDecryptError,
  sealRelayToken,
} from "../src/lib/relay-token.js";
import { __resetSecretCryptoStateForTests } from "../src/lib/secret-crypto.js";

const ORIGINAL_APP_SECRETS_KEY = process.env.APP_SECRETS_KEY;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

describe("relay-token seal/open", () => {
  beforeEach(() => {
    process.env.APP_SECRETS_KEY = "a-fixed-32-char-test-key-value!";
    process.env.NODE_ENV = "test";
    __resetSecretCryptoStateForTests();
  });

  afterEach(() => {
    if (ORIGINAL_APP_SECRETS_KEY === undefined) delete process.env.APP_SECRETS_KEY;
    else process.env.APP_SECRETS_KEY = ORIGINAL_APP_SECRETS_KEY;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    __resetSecretCryptoStateForTests();
  });

  it("round-trips a plaintext token through sealRelayToken and openRelayToken", () => {
    const sealed = sealRelayToken("relay-secret-token");
    expect(openRelayToken(sealed)).toBe("relay-secret-token");
  });

  it("never includes the plaintext in the sealed value", () => {
    const sealed = sealRelayToken("PLAINTEXT-MARKER-TOKEN");
    expect(sealed).not.toContain("PLAINTEXT-MARKER-TOKEN");
  });

  it("produces a different sealed value each time (random IV)", () => {
    expect(sealRelayToken("tok")).not.toBe(sealRelayToken("tok"));
  });

  it("opens null and undefined to null (a server with no stored token)", () => {
    expect(openRelayToken(null)).toBeNull();
    expect(openRelayToken(undefined)).toBeNull();
  });

  it("returns a legacy plaintext token unchanged, one containing colons included", () => {
    // install-relay.ts:229 accepts any \S+ token, so `:` can occur.
    expect(openRelayToken("legacy-plain-token")).toBe("legacy-plain-token");
    expect(openRelayToken("a:b")).toBe("a:b");
    expect(openRelayToken("a:b:c:d:e")).toBe("a:b:c:d:e");
    // 4 parts but the first is not the format marker: not ciphertext shape.
    expect(openRelayToken("v2:a:b:c")).toBe("v2:a:b:c");
    expect(openRelayToken("x:v1:b:c")).toBe("x:v1:b:c");
  });

  it("a plaintext faking the exact v1 4-part shape throws the named error instead of being sent", () => {
    const fake = "v1:AAA:BBB:CCC";
    expect(isRelayTokenCiphertext(fake)).toBe(true);
    let thrown: unknown;
    try {
      openRelayToken(fake);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RelayTokenDecryptError);
    // The error never carries the stored value (it may reach a log).
    expect((thrown as Error).message).not.toContain("AAA");
    expect(String((thrown as Error).message)).not.toContain("BBB");
  });

  it("ciphertext sealed under a different key throws the named error and never leaks the plaintext", () => {
    const sealed = sealRelayToken("SECRET-UNDER-KEY-1");
    process.env.APP_SECRETS_KEY = "another-fixed-32-char-test-key!";
    __resetSecretCryptoStateForTests();
    let thrown: unknown;
    try {
      openRelayToken(sealed);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RelayTokenDecryptError);
    expect((thrown as Error).message).not.toContain("SECRET-UNDER-KEY-1");
  });

  it("recognizes the ciphertext shape exactly (the 4-part v1 form)", () => {
    expect(isRelayTokenCiphertext(sealRelayToken("tok"))).toBe(true);
    expect(isRelayTokenCiphertext("v1:a:b")).toBe(false);
    expect(isRelayTokenCiphertext("v1:a:b:c:d")).toBe(false);
    expect(isRelayTokenCiphertext("tok")).toBe(false);
    expect(isRelayTokenCiphertext("")).toBe(false);
  });
});
