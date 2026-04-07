import { Context, Next } from "hono";
import { timingSafeEqual } from "node:crypto";
import { config } from "../config/index.js";

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Auth middleware — checks for Bearer token or session cookie.
 *
 * Accepts:
 * - Authorization: Bearer <PANEL_TOKEN>
 * - Cookie: panel_session=<PANEL_TOKEN>
 */
export async function requireAuth(c: Context, next: Next) {
  const token = config.PANEL_TOKEN;
  if (!token) {
    if (config.NODE_ENV === "production") {
      console.error("CRITICAL: PANEL_TOKEN is not set in production — all requests will be rejected");
      return c.json({ error: "server_error", message: "Authentication not configured" }, 500);
    }
    return next();
  }

  // Check Authorization header
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ") && safeCompare(auth.slice(7), token)) {
    return next();
  }

  // Check session cookie
  const cookie = c.req.header("Cookie");
  if (cookie) {
    const sessionMatch = cookie.split(";").map(s => s.trim()).find(s => s.startsWith("panel_session="));
    if (sessionMatch && safeCompare(sessionMatch.split("=")[1] ?? "", token)) {
      return next();
    }
  }

  return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
}
