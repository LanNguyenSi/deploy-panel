/**
 * User-session service for the native GitHub OAuth login flow.
 *
 * Sessions are rows in the `sessions` table keyed by sha256(rawToken).
 * The raw token lives only in the browser's `user_session` cookie; the
 * DB never stores it plaintext. 30-day TTL mirrors the legacy
 * panel_session cookie so users have consistent "remember me" behavior
 * across auth methods.
 *
 * Distinct from the existing `panel_session` cookie, which contains the
 * literal PANEL_TOKEN string — that flow stays intact for admin access.
 */
import { randomBytes, createHash } from "node:crypto";
import { prisma } from "./prisma.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const USER_SESSION_COOKIE = "user_session";

export function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string): Promise<{
  token: string;
  expiresAt: Date;
}> {
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.session.create({
    data: { tokenHash, userId, expiresAt },
  });

  return { token, expiresAt };
}

/**
 * Look up a session by its raw cookie value. Returns the associated
 * userId when the session is present and unexpired; null otherwise.
 * The cookie is SHA-256 hashed before the DB lookup so the raw token
 * never appears in a direct string compare (index lookup is not
 * constant-time, but the hash-equality discipline removes the
 * known-plaintext side channel).
 */
export async function validateSession(rawToken: string): Promise<string | null> {
  if (!rawToken) return null;
  const tokenHash = hashSessionToken(rawToken);
  const session = await prisma.session.findUnique({ where: { tokenHash } });
  if (!session) return null;
  if (session.expiresAt < new Date()) return null;
  return session.userId;
}

export async function deleteSession(rawToken: string): Promise<void> {
  if (!rawToken) return;
  const tokenHash = hashSessionToken(rawToken);
  await prisma.session.deleteMany({ where: { tokenHash } });
}

/**
 * Build a Set-Cookie header value for the user session. Lax SameSite is
 * required so the cookie survives the cross-site navigation back from
 * github.com after OAuth.
 */
export function buildUserSessionCookie(token: string, secure: boolean): string {
  const parts = [
    `${USER_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    "Path=/",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearUserSessionCookie(): string {
  return `${USER_SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`;
}

export function readUserSessionCookie(cookieHeader: string | undefined | null): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${USER_SESSION_COOKIE}=([^;]+)`),
  );
  return match ? decodeURIComponent(match[1] ?? "") : null;
}
