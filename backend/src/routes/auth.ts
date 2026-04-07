import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { timingSafeEqual } from "node:crypto";
import { config } from "../config/index.js";

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export const authRouter = new Hono();

const loginSchema = z.object({
  token: z.string().min(1),
});

// POST /api/auth/login — set session cookie
authRouter.post("/login", zValidator("json", loginSchema), async (c) => {
  const { token } = c.req.valid("json");

  if (!config.PANEL_TOKEN || !safeCompare(token, config.PANEL_TOKEN)) {
    return c.json({ error: "unauthorized", message: "Invalid token" }, 401);
  }

  // Set httpOnly cookie
  c.header(
    "Set-Cookie",
    `panel_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${config.NODE_ENV === "production" ? "; Secure" : ""}`,
  );

  return c.json({ success: true });
});

// POST /api/auth/logout — clear session
authRouter.post("/logout", async (c) => {
  c.header("Set-Cookie", "panel_session=; Path=/; HttpOnly; Max-Age=0");
  return c.json({ success: true });
});

// GET /api/auth/check — check if authenticated
authRouter.get("/check", async (c) => {
  const token = config.PANEL_TOKEN;
  if (!token) return c.json({ authenticated: true }); // no auth configured

  const cookie = c.req.header("Cookie");
  if (cookie) {
    const session = cookie.split(";").map(s => s.trim()).find(s => s.startsWith("panel_session="));
    if (session && session.split("=")[1] === token) {
      return c.json({ authenticated: true });
    }
  }

  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ") && auth.slice(7) === token) {
    return c.json({ authenticated: true });
  }

  return c.json({ authenticated: false }, 401);
});
