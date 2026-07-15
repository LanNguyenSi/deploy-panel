import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// secret-crypto.ts deliberately reads process.env directly (NOT the config
// module — importing config/index.ts would pull in ITS top-level
// `configSchema.safeParse(...).success || process.exit(1)` side effect into
// every module that transitively imports secret-crypto, e.g. apps.ts/v1.ts/
// stream-deploy.ts via app-secrets.ts. That regressed 4 pre-existing test
// suites that mock relay/prisma but never set SESSION_SECRET — see the
// "does not import config" guard below). So these tests manipulate
// process.env directly, not a mocked config module.

import {
  encryptSecretValue,
  decryptSecretValue,
  __resetSecretCryptoStateForTests,
} from "../src/lib/secret-crypto.js";

const ORIGINAL_APP_SECRETS_KEY = process.env.APP_SECRETS_KEY;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

describe("secret-crypto", () => {
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

  it("does not import config/index.ts (which process.exit(1)s at import time on invalid env)", async () => {
    // Regression guard for the HIGH finding: secret-crypto.ts is now
    // transitively imported by apps.ts/v1.ts/stream-deploy.ts. If it ever
    // imports the config module again, every test suite that imports those
    // route/lib modules without SESSION_SECRET set would crash at import
    // (process.exit(1)) instead of failing an assertion.
    const fs = await import("node:fs/promises");
    const url = await import("node:url");
    const path = url.fileURLToPath(new URL("../src/lib/secret-crypto.ts", import.meta.url));
    const source = await fs.readFile(path, "utf8");
    expect(source).not.toMatch(/from ["']\.\.\/config\/index\.js["']/);
  });

  it("round-trips a plaintext value through encrypt then decrypt", () => {
    const stored = encryptSecretValue("s3cr3t-token-value");
    expect(decryptSecretValue(stored)).toBe("s3cr3t-token-value");
  });

  it("never includes the plaintext in the stored ciphertext string", () => {
    const stored = encryptSecretValue("METRICS_API_TOKEN_VALUE_XYZ");
    expect(stored).not.toContain("METRICS_API_TOKEN_VALUE_XYZ");
  });

  it("produces a different ciphertext each time (random IV) for the same plaintext", () => {
    const a = encryptSecretValue("same-value");
    const b = encryptSecretValue("same-value");
    expect(a).not.toBe(b);
    expect(decryptSecretValue(a)).toBe("same-value");
    expect(decryptSecretValue(b)).toBe("same-value");
  });

  it("rejects a tampered ciphertext (GCM auth tag mismatch)", () => {
    const stored = encryptSecretValue("integrity-check");
    const parts = stored.split(":");
    // Flip a byte in the ciphertext (last segment) to corrupt it.
    const corruptedCt = Buffer.from(parts[3], "base64");
    corruptedCt[0] ^= 0xff;
    const corrupted = [parts[0], parts[1], parts[2], corruptedCt.toString("base64")].join(":");
    expect(() => decryptSecretValue(corrupted)).toThrow();
  });

  it("falls back to a dev-only key with a warning when APP_SECRETS_KEY is unset outside production", () => {
    delete process.env.APP_SECRETS_KEY;
    process.env.NODE_ENV = "development";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const stored = encryptSecretValue("dev-value");
    expect(decryptSecretValue(stored)).toBe("dev-value");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("APP_SECRETS_KEY"));

    warnSpy.mockRestore();
  });

  it("throws (fails closed) when APP_SECRETS_KEY is unset in production", () => {
    delete process.env.APP_SECRETS_KEY;
    process.env.NODE_ENV = "production";

    expect(() => encryptSecretValue("prod-value")).toThrow(/APP_SECRETS_KEY/);
  });

  it("defaults to development semantics (no throw) when NODE_ENV itself is unset, mirroring config's own default", () => {
    delete process.env.APP_SECRETS_KEY;
    delete process.env.NODE_ENV;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => encryptSecretValue("no-node-env")).not.toThrow();

    warnSpy.mockRestore();
  });
});
