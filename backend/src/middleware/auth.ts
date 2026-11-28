import { Context, Next } from "hono";
import { createHash } from "node:crypto";
import { config } from "../config/index.js";
import { prisma } from "../lib/prisma.js";
import { buildClearUserSessionCookie, readUserSessionCookie, validateSession } from "../lib/session.js";
import { parsePanelSessionCookie, safeCompare } from "../lib/panel-token.js";
import { validatePanelSession } from "../lib/panel-session.js";
import {
  acquireLookupSlot,
  checkLoginBlocked,
  loginClientKey,
  recordLoginFailure,
  type LookupSlotResult,
} from "../lib/login-rate-limit.js";

/** Set-Cookie value that clears `panel_session` (same attributes as logout). */
export const CLEAR_PANEL_SESSION_COOKIE = "panel_session=; Path=/; HttpOnly; Max-Age=0";

/**
 * The `user_session` cookie a request presents. `carried` is true when the
 * header holds one; `token` is its decoded value, or null when the value is
 * malformed (readUserSessionCookie throws URIError on bad percent-encoding,
 * for example `user_session=%`). A malformed cookie counts as carried but
 * invalid, and reading it never throws.
 */
export function presentedUserSession(
  cookieHeader: string | undefined,
): { carried: boolean; token: string | null } {
  try {
    const token = readUserSessionCookie(cookieHeader);
    return { carried: token !== null, token };
  } catch {
    return { carried: true, token: null };
  }
}

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
 * 3. Admin session cookie (panel_session=<random session token> issued by
 *    POST /api/auth/login, lib/panel-session.ts; never the PANEL_TOKEN)
 * 4. GitHub OAuth session cookie (user_session)
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
 *                  their own.
 *
 * Failed presentations share the failure budget of POST /api/auth/login
 * (lib/login-rate-limit.ts, same client key and constants): a blocked key
 * gets 429 `rate_limited` with Retry-After before any credential is
 * compared or looked up, valid ones included. Each presented credential that
 * fails records one failure: a `dp_` key that is unknown or revoked, a
 * non-`dp_` Bearer that is not the PANEL_TOKEN (also when a cookie then
 * succeeds; an admin session token as Bearer is such a Bearer), a
 * `panel_session` cookie that is not a live admin session (the PANEL_TOKEN
 * itself included), and a `user_session` cookie without a valid session (a
 * malformed value included). Successful presentations
 * never record. A failed `panel_session` or `user_session` cookie is cleared
 * with a Set-Cookie on the response (and on the 429 when the request carried
 * it), so a browser holding a stale cookie (an admin session the server
 * dropped after a restart, logout or expiry, a revoked or expired GitHub
 * session) stops spending the budget.
 *
 * The two awaited lookups (a `dp_` key, a `user_session` cookie) each take a
 * lookup slot of the client key first (`acquireLookupSlot`): at most the
 * remaining budget (LOGIN_RATE_MAX minus the failures already counted) of
 * lookups run at once per client, so a concurrent burst cannot get more of
 * these two lookups evaluated than the budget. The synchronous comparisons
 * (a non-`dp_` Bearer, a `panel_session` cookie, a malformed `user_session`)
 * take no slot: their failures, recorded while lookups are in flight, are not
 * held back, so one mixed burst can get up to about twice the budget
 * evaluated across credential kinds, each kind at most the budget. Further
 * requests wait for a slot: once the budget is spent they answer the 429
 * above, otherwise they are evaluated, so a burst of valid presentations is
 * delayed, not refused or logged out. A failed lookup records its failure as
 * it releases the slot; a successful or thrown one records nothing. A
 * request beyond the per-client waiter cap, or one that waited longer than
 * the wait timeout, gets 503 `auth_busy` with Retry-After: 1: the lookup
 * records nothing and the `user_session` cookie is not cleared (a failure
 * the same request's synchronous comparisons recorded before stays recorded).
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
  // (likewise deploys, scheduled and api-keys), and Hono matches both patterns for the
  // bare path, so it can run twice on one request. Once a credential has been
  // accepted, the second run passes without evaluating the credentials again,
  // so a failed credential next to the accepted one is recorded only once.
  if ((c as any).get("authType") !== undefined) return next();

  const clientKey = loginClientKey(c);
  const cookie = c.req.header("Cookie");
  const panelCookie = parsePanelSessionCookie(cookie);
  const userSession = presentedUserSession(cookie);
  const clearPanelCookie = () =>
    c.header("Set-Cookie", CLEAR_PANEL_SESSION_COOKIE, { append: true });
  const clearUserCookie = () =>
    c.header("Set-Cookie", clearUserSessionCookie(), { append: true });

  let panelCookieCleared = false;
  const rateLimited = (retryAfterSec: number) => {
    if (panelCookie !== null && !panelCookieCleared) clearPanelCookie();
    if (userSession.carried) clearUserCookie();
    c.header("Retry-After", String(retryAfterSec));
    return c.json(
      { error: "rate_limited", message: "too many failed authentication attempts; retry later" },
      429,
    );
  };
  // A request that got no lookup slot: blocked answers the normal 429; busy
  // (waiter cap or wait timeout): the lookup records nothing and the
  // user_session cookie is not cleared.
  const refuseWithoutSlot = (r: Exclude<LookupSlotResult, { status: "acquired" }>) => {
    if (r.status === "blocked") return rateLimited(r.retryAfterSec);
    c.header("Retry-After", "1");
    return c.json(
      { error: "auth_busy", message: "too many authentication requests in flight; retry shortly" },
      503,
    );
  };

  const limit = checkLoginBlocked(clientKey);
  if (limit.blocked) return rateLimited(limit.retryAfterSec);

  // Check Authorization header
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const bearer = auth.slice(7);

    // API Key (prefixed with dp_)
    if (bearer.startsWith("dp_")) {
      const keyHash = hashApiKey(bearer);
      const acquired = await acquireLookupSlot(clientKey);
      if (acquired.status !== "acquired") return refuseWithoutSlot(acquired);
      const { slot } = acquired;
      let apiKey;
      try {
        apiKey = await prisma.apiKey.findUnique({ where: { keyHash } });
      } catch (err) {
        slot.release();
        throw err;
      }
      if (apiKey && !apiKey.revokedAt) {
        slot.release();
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
      slot.fail();
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

  // Check panel_session cookie: a live admin session from the in-memory
  // store. The raw PANEL_TOKEN is a Bearer credential only and fails here.
  if (panelCookie !== null) {
    if (validatePanelSession(panelCookie)) {
      c.set("authType", "session");
      c.set("isAdmin", true);
      return next();
    }
    recordLoginFailure(clientKey);
    clearPanelCookie();
    panelCookieCleared = true;
  }

  // Check user_session cookie (native GitHub OAuth login). Non-admin;
  // userId comes from the session row. A malformed cookie is not looked up
  // and fails like an unknown session.
  if (userSession.carried) {
    let userId: string | null = null;
    if (userSession.token) {
      const acquired = await acquireLookupSlot(clientKey);
      if (acquired.status !== "acquired") return refuseWithoutSlot(acquired);
      const { slot } = acquired;
      try {
        userId = await validateSession(userSession.token);
      } catch (err) {
        slot.release();
        throw err;
      }
      if (userId) {
        slot.release();
        c.set("authType", "session");
        c.set("userId", userId);
        c.set("isAdmin", false);
        return next();
      }
      slot.fail();
    } else {
      recordLoginFailure(clientKey);
    }
    clearUserCookie();
  }

  return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
}

/**
 * Admin-only gate for API key management: only the panel token or a live
 * `panel_session` admin session may pass. Must be used AFTER requireAuth.
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
