import { decryptSecretValue, encryptSecretValue } from "./secret-crypto.js";

/**
 * Encrypt-at-rest for `Server.relayToken`, on top of the AppSecret cipher in
 * `lib/secret-crypto.ts` (same key, same `v1:<iv>:<tag>:<ct>` format; see
 * docs/configuration.md "App secrets"). No schema change: the ciphertext
 * replaces the plaintext in the same column.
 *
 * Reading a stored value is shape-dispatched, because the column also holds
 * rows written before encryption existed:
 *
 * - `null`/`undefined` → `null` (the server has no token; no header).
 * - A value in the exact ciphertext shape (4 colon-separated parts starting
 *   with `v1`, which is exactly what `decryptSecretValue` accepts) → decrypt
 *   it. A decrypt failure throws `RelayTokenDecryptError`; callers treat that
 *   as "fail this relay call", never as "send the stored value anyway".
 * - Anything else → a legacy plaintext token, used as is. Tokens are any
 *   `\S+`, so a plaintext may contain `:`; only the exact 4-part `v1:` shape
 *   is treated as ciphertext. A plaintext that fakes that shape is read as
 *   corrupt ciphertext and throws the same named error, the accepted cost
 *   of a shape-based dispatch, mirroring the app-secret loader.
 *
 * Writes always seal: every code path that stores a token routes it through
 * `sealRelayToken`, so new rows are always ciphertext. The startup backfill
 * (`backfillRelayTokenCiphertext` in `lib/startup.ts`) converts the pre-
 * encryption rows. `APP_SECRETS_KEY` protects these tokens too: a lost key
 * means re-installing every relay (there is no plaintext copy left to read).
 *
 * This module must not import `lib/prisma.js`: it sits under `lib/relay.ts`
 * and `services/relay-self-update.ts`, and the backfill belongs with the
 * other startup database passes. Like secret-crypto.ts it pulls no config in
 * either (that module exits the process on invalid env; see the comment
 * there).
 */

/**
 * A stored relay token was in ciphertext shape but did not decrypt (wrong
 * `APP_SECRETS_KEY`, a value that fakes the shape, or a corrupt row). Never
 * carries the token value in its message. Callers fail the relay call; the
 * stored value must never go out as a bearer token.
 */
export class RelayTokenDecryptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RelayTokenDecryptError";
  }
}

/**
 * True exactly for values `decryptSecretValue` will attempt to decrypt: 4
 * colon-separated parts whose first part is the format marker `v1`. Standard
 * base64 (what the cipher's parts are) contains no `:`; a legacy plaintext
 * with 4 `:`-separated parts starting with `v1` matches too and then fails
 * the authentication check; see the module comment.
 */
export function isRelayTokenCiphertext(value: string): boolean {
  const parts = value.split(":");
  return parts.length === 4 && parts[0] === "v1";
}

/** Encrypt a plaintext relay token into the stored ciphertext form. */
export function sealRelayToken(plaintext: string): string {
  return encryptSecretValue(plaintext);
}

/**
 * Turn a stored `Server.relayToken` value into the bearer token to send.
 * `null`/`undefined` (no token) → `null`; legacy plaintext → returned
 * unchanged; ciphertext → decrypted, or `RelayTokenDecryptError` on any
 * decrypt failure (a missing `APP_SECRETS_KEY` in production throws the
 * secret-crypto error unchanged from `sealRelayToken` and from this path's
 * key derivation, wrapped here like any other decrypt failure).
 */
export function openRelayToken(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined) return null;
  if (!isRelayTokenCiphertext(stored)) return stored;
  try {
    return decryptSecretValue(stored);
  } catch (err) {
    throw new RelayTokenDecryptError("stored relay token is in ciphertext shape but did not decrypt (wrong APP_SECRETS_KEY, a fake v1-prefixed value, or a corrupt row)", { cause: err });
  }
}
