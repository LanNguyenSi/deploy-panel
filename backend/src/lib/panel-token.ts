/**
 * Shared panel-credential comparison and `panel_session` cookie parsing.
 *
 * `safeCompare` decides "is this the PANEL_TOKEN" for the Bearer path
 * (middleware/auth.ts, routes/auth.ts /check) and the login secret (/login)
 * identically. The `panel_session` cookie is not the PANEL_TOKEN: its value is
 * a random admin session token, checked against lib/panel-session.ts. Only
 * the cookie parsing lives here so every gate reads the same value.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * SHA-256 keeps both buffers 32 bytes, so timingSafeEqual cannot throw on a
 * string-length match with a UTF-8 byte-length mismatch (multi-byte input).
 * The old form (early return on `a.length !== b.length`, then
 * timingSafeEqual on Buffer.from(a)/Buffer.from(b)) answered 500 for a
 * multi-byte credential whose char length equalled the token's.
 */
export function safeCompare(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

export const PANEL_SESSION_COOKIE = "panel_session";

/**
 * Extract the `panel_session` cookie value: everything between the cookie
 * name and the next `;`. Splitting on `=` and taking `[1]` truncates at a
 * second `=`, which accepted `panel_session=<token>=x` and rejected a
 * PANEL_TOKEN that legitimately contains `=` (base64 padding).
 */
export function parsePanelSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const prefix = `${PANEL_SESSION_COOKIE}=`;
  for (const part of cookieHeader.split(";")) {
    const cookie = part.trim();
    if (cookie.startsWith(prefix)) return cookie.slice(prefix.length);
  }
  return null;
}
