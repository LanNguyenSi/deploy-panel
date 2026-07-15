import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Encrypt-at-rest for AppSecret.valueCiphertext (see lib/app-secrets.ts).
 *
 * Key material comes from APP_SECRETS_KEY, scrypt-derived into a 256-bit key
 * so the raw env var doesn't have to be exactly 32 bytes. Deliberately a
 * separate secret from SESSION_SECRET: rotating the session secret (routine
 * security hygiene) must not silently brick every stored app secret.
 *
 * Dev fallback: with no APP_SECRETS_KEY set, non-production falls back to a
 * fixed, publicly-known dev key (so `make dev` works with zero setup) and
 * logs a warning. Production has no fallback — encrypt/decrypt throws so a
 * missing key fails closed instead of silently protecting secrets with a
 * key anyone can read in this file.
 *
 * Deliberately reads `process.env` directly instead of importing
 * `../config/index.js`: that module's top-level `configSchema.safeParse`
 * calls `process.exit(1)` when ANY required var (e.g. SESSION_SECRET) is
 * missing/invalid — a side effect fine for the server entrypoint but wrong
 * for a leaf crypto module that apps.ts/v1.ts/stream-deploy.ts now pull in
 * transitively. A test suite that mocks relay/prisma but never sets
 * SESSION_SECRET must be able to import this file without the whole
 * process exiting. See AGENTS.md "no silent errors" — this reads env
 * directly rather than swallowing the config-import problem.
 */

const DEV_FALLBACK_KEY_MATERIAL =
  "dev-only-app-secrets-key-NOT-FOR-PRODUCTION-usage-set-APP_SECRETS_KEY";

let cachedKey: Buffer | null = null;
let warnedDevFallback = false;

function keyMaterial(): string {
  const configuredKey = process.env.APP_SECRETS_KEY;
  if (configuredKey) return configuredKey;
  // Mirrors config/index.ts's own zod default (`NODE_ENV.default("development")`)
  // without importing that module — see the module doc comment above.
  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (nodeEnv === "production") {
    throw new Error(
      "APP_SECRETS_KEY must be set in production to store or read app secrets",
    );
  }
  if (!warnedDevFallback) {
    console.warn(
      "[app-secrets] APP_SECRETS_KEY not set — using an insecure dev-only fallback key. " +
        "Set APP_SECRETS_KEY before storing real secrets.",
    );
    warnedDevFallback = true;
  }
  return DEV_FALLBACK_KEY_MATERIAL;
}

function getKey(): Buffer {
  // scrypt is CPU-heavy; the key material is fixed per process, so derive
  // once and cache. NODE_ENV/APP_SECRETS_KEY don't change at runtime.
  if (!cachedKey) {
    cachedKey = scryptSync(keyMaterial(), "deploy-panel-app-secrets-v1", 32);
  }
  return cachedKey;
}

const CIPHERTEXT_VERSION = "v1";
const IV_BYTES = 12; // recommended nonce size for AES-GCM

/** Encrypt a plaintext secret value into the stored ciphertext format. */
export function encryptSecretValue(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    CIPHERTEXT_VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/** Decrypt a stored ciphertext back into the plaintext secret value. */
export function decryptSecretValue(stored: string): string {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== CIPHERTEXT_VERSION) {
    throw new Error("Unsupported or corrupt app-secret ciphertext");
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const key = getKey();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

// Test-only seam: let tests reset the memoized key/warning state after
// mutating process.env.APP_SECRETS_KEY / process.env.NODE_ENV.
export function __resetSecretCryptoStateForTests(): void {
  cachedKey = null;
  warnedDevFallback = false;
}
