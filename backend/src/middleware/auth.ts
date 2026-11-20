import { Context, Next } from "hono";
import { createHash } from "node:crypto";
import { config } from "../config/index.js";
import { prisma } from "../lib/prisma.js";
import { buildClearUserSessionCookie, readUserSessionCookie, validateSession } from "../lib/session.js";
import { parsePanelSessionCookie, safeCompare } from "../lib/panel-token.js";
import { checkLoginBlocked, loginClientKey, recordLoginFailure } from "../lib/login-rate-limit.js";

/** Set-Cookie value that clears `panel_session` (same attributes as logout). */
export const CLEAR_PANEL_SESSION_COOKIE = "panel_session=; Path=/; HttpOnly; Max-Age=0";

/**
 * Set-Cookie value that clears `user_session`, with the attributes of the
 * cookie the OAuth callback issues (`buildUserSessionCookie`: HttpOnly,
 * SameSite=Lax, Path=/, no Domain, Secure in production).
 */
export function clearUserSessionCookie(): string {
  return `${buildClearUserSessionCookie()}${config.NODE_ENV === "production" ? "; Secure" : ""}`;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Auth middleware — checks for:
 * 1. API Key (Bearer dp_...)
 * 2. Panel token (Bearer <PANEL_TOKEN>)
 * 3. Session cookie (panel_session=<PANEL_TOKEN>)
 *
 * Sets on the request context:
 *   authType     — "api_key" | "panel" | "session"
 *   apiKeyName   — when authType === "api_key"
 *   userId       — the owning User.id, when the credential is user-bound.
 *                  Null for panel/session auth and for legacy admin-created
 *                  ApiKey rows that have no userId FK.
 *   isAdmin      — true for panel/session auth AND for ApiKey rows without
 *                  userId (legacy admin keys). Admin sees all resources;
 *                  non-admin actors only see rows where Server.userId matches
 *                  their own. *
 * Failed presentations share the failure budget of POST /api/auth/login
 * (lib/login-rate-limit.ts, same client key and constants): a blocked key
 * gets 429 `rate_limited` with Retry-After before any credential is
 * compared or looked up, valid ones included. Each presented credential that
 * fails records one failure: a `dp_` key that is unknown or revoked, a
 * non-`dp_` Bearer that is not the PANEL_TOKEN (also when a cookie then
 * succeeds), a `panel_session` cookie that is not the PANEL_TOKEN, and a
 * `user_session` cookie without a valid session. Successful presentations
 * never record. A failed `panel_session` or `user_session` cookie is cleared
 * with a Set-Cookie on the response (and on the 429 when the request carried
 * it), so a browser holding a stale cookie (a rotated PANEL_TOKEN, a revoked
 * or expired GitHub session) stops spending the budget.
 */
export async function requireAuth(c: Context, next: Next) {
  const token = config.PANEL_TOKEN;
  if (!token) {
    if (config.NODE_ENV === "production") {
      console.error("CRITICAL: PANEL_TOKEN is not set in production — all requests will be rejected");
      return c.json({ error: "server_error", message: "Authentication not configured" }, 500);
    }
    // Dev fallback: treat as admin so local-dev tooling keeps working.
    c.set("isAdmin", true);
    return next();
  }

  // app.ts mounts this middleware on both "/api/servers" and "/api/servers/*"
  // (likewise deploys and scheduled), and Hono matches both patterns for the
  // bare path, so it can run twice on one request. Once a credential has been
  // accepted, the second run passes without evaluating the credentials again,
  // so a failed credential next to the accepted one is recorded only once.
  if ((c as any).get("authType") !== undefined) return next();

  const clientKey = loginClientKey(c);
  const cookie = c.req.header("Cookie");
  const panelCookie = parsePanelSessionCookie(cookie);
  const userSessionToken = readUserSessionCookie(cookie);
  const clearPanelCookie = () =>
    c.header("Set-Cookie", CLEAR_PANEL_SESSION_COOKIE, { append: true });
  const clearUserCookie = () =>
    c.header("Set-Cookie", clearUserSessionCookie(), { append: true });

  const limit = checkLoginBlocked(clientKey);
  if (limit.blocked) {
    if (panelCookie !== null) clearPanelCookie();
    if (userSessionToken !== null) clearUserCookie();
    c.header("Retry-After", String(limit.retryAfterSec));
    return c.json(
      { error: "rate_limited", message: "too many failed authentication attempts; retry later" },
      429,
    );
  }

  // Check Authorization header
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const bearer = auth.slice(7);

    // API Key (prefixed with dp_)
    if (bearer.startsWith("dp_")) {
      const keyHash = hashApiKey(bearer);
      const apiKey = await prisma.apiKey.findUnique({ where: { keyHash } });
      if (apiKey && !apiKey.revokedAt) {
        // Update lastUsedAt (fire-and-forget)
        prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
        c.set("authType", "api_key");
        c.set("apiKeyName", apiKey.name);
        if (apiKey.userId) {
          c.set("userId", apiKey.userId);
          c.set("isAdmin", false);
        } else {
          // Legacy admin-created key with no user binding.
          c.set("isAdmin", true);
        }
        return next();
      }
      recordLoginFailure(clientKey);
      return c.json({ error: "unauthorized", message: "Invalid or revoked API key" }, 401);
    }

    // Panel token
    if (safeCompare(bearer, token)) {
      c.set("authType", "panel");
      c.set("isAdmin", true);
      return next();
    }
    recordLoginFailure(clientKey);
  }

  // Check panel_session cookie (legacy admin path — contains raw PANEL_TOKEN).
  if (panelCookie !== null) {
    if (safeCompare(panelCookie, token)) {
      c.set("authType", "session");
      c.set("isAdmin", true);
      return next();
    }
    recordLoginFailure(clientKey);
    clearPanelCookie();
  }

  // Check user_session cookie (native GitHub OAuth login). Non-admin;
  // userId comes from the session row.
  if (userSessionToken) {
    const userId = await validateSession(userSessionToken);
    if (userId) {
      c.set("authType", "session");
      c.set("userId", userId);
      c.set("isAdmin", false);
      return next();
    }
    recordLoginFailure(clientKey);
    clearUserCookie();
  }

  return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
}

/**
 * Admin-only gate for API key management: only the panel token or the
 * `panel_session` cookie may pass. Must be used AFTER requireAuth.
 *
 * Two checks, because neither alone is enough:
 *  - `authType === "api_key"` is refused even for a legacy admin key (a key
 *    must not be able to mint or revoke keys).
 *  - `isAdmin !== true` is refused for a native GitHub OAuth `user_session`,
 *    which also has `authType === "session"` but is a non-admin user. Without
 *    this check such a user could create an ApiKey row with no `userId`,
 *    which requireAuth treats as a legacy admin key.
 */
export async function requirePanelAuth(c: Context, next: Next) {
  const authType = (c as any).get("authType");
  if (authType === "api_key") {
    return c.json({ error: "forbidden", message: "API key management requires panel authentication" }, 403);
  }
  if ((c as any).get("isAdmin") !== true) {
    return c.json({ error: "forbidden", message: "API key management requires admin access" }, 403);
  }
  return next();
}
