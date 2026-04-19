import { Context, Next } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "../config/index.js";
import { prisma } from "../lib/prisma.js";
import { readUserSessionCookie, validateSession } from "../lib/session.js";

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
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
 *                  their own.
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
      return c.json({ error: "unauthorized", message: "Invalid or revoked API key" }, 401);
    }

    // Panel token
    if (safeCompare(bearer, token)) {
      c.set("authType", "panel");
      c.set("isAdmin", true);
      return next();
    }
  }

  // Check panel_session cookie (legacy admin path — contains raw PANEL_TOKEN).
  const cookie = c.req.header("Cookie");
  if (cookie) {
    const panelMatch = cookie.split(";").map(s => s.trim()).find(s => s.startsWith("panel_session="));
    if (panelMatch && safeCompare(panelMatch.split("=")[1] ?? "", token)) {
      c.set("authType", "session");
      c.set("isAdmin", true);
      return next();
    }
  }

  // Check user_session cookie (native GitHub OAuth login). Non-admin;
  // userId comes from the session row.
  const userSessionToken = readUserSessionCookie(cookie);
  if (userSessionToken) {
    const userId = await validateSession(userSessionToken);
    if (userId) {
      c.set("authType", "session");
      c.set("userId", userId);
      c.set("isAdmin", false);
      return next();
    }
  }

  return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
}

/**
 * Rejects API key auth — only panel token or session cookie allowed.
 * Must be used AFTER requireAuth.
 */
export async function requirePanelAuth(c: Context, next: Next) {
  const authType = (c as any).get("authType");
  if (authType === "api_key") {
    return c.json({ error: "forbidden", message: "API key management requires panel authentication" }, 403);
  }
  return next();
}
