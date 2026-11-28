/**
 * The requireAuth middleware gate (GET /api/servers through createApp) and
 * GET /api/auth/check decide the panel credential identically, through the
 * shared helpers in backend/src/lib/panel-token.ts (the Bearer comparison and
 * the cookie parser) and backend/src/lib/panel-session.ts (the admin session
 * the cookie must name; the raw PANEL_TOKEN is not one).
 *
 * Defects guarded here (old middleware/auth.ts behaviour):
 * - its own safeCompare returned early on a character-length match and then
 *   called timingSafeEqual on buffers of different UTF-8 byte length, which
 *   threw and answered 500 for a multi-byte credential (now 401);
 * - it parsed the cookie with split("=")[1], so panel_session=<token>=x was
 *   accepted, and a PANEL_TOKEN legitimately containing "=" (base64 padding)
 *   was rejected by the middleware while /check (which read the full value)
 *   accepted it, the two gates disagreeing. The padded token is now a Bearer
 *   credential only; the cookie parser still reads the full value.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    apiKey: { findUnique: vi.fn(), update: vi.fn() },
    user: { upsert: vi.fn() },
  },
}));

vi.mock("../src/config/index.js", () => ({
  config: {
    NODE_ENV: "test",
    PANEL_TOKEN: "cGFuZWwtdG9rZW4td2l0aC1wYWQ=",
    SESSION_SECRET: "session-secret-must-be-16chars",
    CORS_ORIGINS: "http://localhost:3000",
    FRONTEND_URL: "http://localhost:3000",
    PORT: 3001,
    ALLOWED_GITHUB_LOGINS: "",
  },
  allowedGitHubLogins: [],
}));

import { config } from "../src/config/index.js";
import { createApp } from "../src/app.js";
import { _resetLoginRateLimit } from "../src/lib/login-rate-limit.js";
import { _resetPanelSessions, createPanelSession } from "../src/lib/panel-session.js";

// base64 of "panel-token-with-pad": a token that legitimately contains "=",
// so the two gates can be tested for agreement on it.
const PADDED = "cGFuZWwtdG9rZW4td2l0aC1wYWQ=";

const app = createApp("http://localhost:3000");

const servers = (headers: Record<string, string>) =>
  app.request("/api/servers", { headers });
const check = (headers: Record<string, string>) =>
  app.request("/api/auth/check", { headers });

describe("requireAuth panel-token gate (GET /api/servers)", () => {
  let session = "";

  beforeEach(() => {
    config.PANEL_TOKEN = PADDED;
    _resetLoginRateLimit();
    _resetPanelSessions();
    session = createPanelSession();
  });

  it("correct Bearer token passes the gate", async () => {
    const res = await servers({ Authorization: `Bearer ${PADDED}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ servers: [] });
  });

  it("live panel_session cookie passes the gate", async () => {
    const res = await servers({ Cookie: `panel_session=${session}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ servers: [] });
  });

  it("the raw PANEL_TOKEN as panel_session cookie is refused", async () => {
    const res = await servers({ Cookie: `panel_session=${PADDED}` });
    expect(res.status).toBe(401);
  });

  it("multi-byte Bearer (equal char length, different byte length) is 401, not 500", async () => {
    const res = await servers({ Authorization: `Bearer ${"ä".repeat(PADDED.length)}` });
    expect(res.status).toBe(401);
  });

  it("multi-byte cookie is 401, not 500", async () => {
    const res = await servers({ Cookie: `panel_session=${"ä".repeat(PADDED.length)}` });
    expect(res.status).toBe(401);
  });

  it("panel_session=<session>=x is refused", async () => {
    const res = await servers({ Cookie: `panel_session=${session}=x` });
    expect(res.status).toBe(401);
  });

  it("a token containing = (base64 padding): the correct Bearer passes the gate", async () => {
    const res = await servers({ Authorization: `Bearer ${PADDED}` });
    expect(res.status).toBe(200);
  });

  it("a token containing =: the middleware and /check agree on the same Bearer", async () => {
    const gated = await servers({ Authorization: `Bearer ${PADDED}` });
    const checked = await check({ Authorization: `Bearer ${PADDED}` });
    expect(gated.status).toBe(200);
    expect(checked.status).toBe(200);
    expect(await checked.json()).toEqual({ authenticated: true });
  });

  it("the middleware and /check agree on a live session cookie", async () => {
    const gated = await servers({ Cookie: `panel_session=${session}` });
    const checked = await check({ Cookie: `panel_session=${session}` });
    expect(gated.status).toBe(200);
    expect(checked.status).toBe(200);
    expect(await checked.json()).toEqual({ authenticated: true });
  });

  it("the middleware and /check agree on the raw PANEL_TOKEN as cookie: both refuse", async () => {
    const gated = await servers({ Cookie: `panel_session=${PADDED}` });
    const checked = await check({ Cookie: `panel_session=${PADDED}` });
    expect(gated.status).toBe(401);
    expect(checked.status).toBe(401);
  });

  it("wrong Bearer and wrong cookie together stay 401", async () => {
    const res = await servers({
      Authorization: `Bearer ${"z".repeat(PADDED.length)}`,
      Cookie: `panel_session=${"y".repeat(PADDED.length)}`,
    });
    expect(res.status).toBe(401);
  });

  it("/check refuses panel_session=<session>=x", async () => {
    const res = await check({ Cookie: `panel_session=${session}=x` });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ authenticated: false });
  });
});
