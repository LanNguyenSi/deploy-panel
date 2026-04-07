import { Context, Next } from "hono";
import { config } from "../config/index.js";

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
    // No token configured — skip auth (dev mode)
    return next();
  }

  // Check Authorization header
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ") && auth.slice(7) === token) {
    return next();
  }

  // Check session cookie
  const cookie = c.req.header("Cookie");
  if (cookie) {
    const sessionMatch = cookie.split(";").map(s => s.trim()).find(s => s.startsWith("panel_session="));
    if (sessionMatch && sessionMatch.split("=")[1] === token) {
      return next();
    }
  }

  return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
}
