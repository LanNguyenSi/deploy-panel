/**
 * Failed credential presentations on GET /api/auth/check and in the
 * requireAuth middleware share the failure budget of POST /api/auth/login
 * (lib/login-rate-limit.ts). Without this, the 10-per-15-minutes limit on
 * /login could be bypassed by guessing PANEL_TOKEN as a Bearer header or a
 * panel_session cookie on any requireAuth route or on /check.
 *
 * Rules pinned here:
 * - every failed presentation records one failure: a non-dp_ Bearer, a
 *   panel_session cookie, an unknown or revoked dp_ key, a user_session
 *   cookie without a valid session; a failing Bearer next to a succeeding
 *   cookie still records one;
 * - a successful presentation never records and never clears other failures;
 * - a blocked key gets 429 rate_limited with Retry-After before any
 *   comparison or lookup, valid credentials included;
 * - a failed panel_session cookie is cleared with a Set-Cookie (also on the
 *   429), a request without one gets no clearing header;
 * - a stale cookie after a PANEL_TOKEN rotation costs one failure per request
 *   (no dedupe), so one dashboard load with its two parallel requests costs 2.
 *
 * Direct app.request() calls have no socket, so every request here lands on
 * the shared "unknown" key (the key rule itself is tested in
 * login-rate-limit.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
    deploy: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    apiKey: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    session: { findUnique: vi.fn() },
    user: { upsert: vi.fn() },
  },
}));

vi.mock("../src/config/index.js", () => ({
  config: {
    NODE_ENV: "test",
    PANEL_TOKEN: "panel-token-must-be-16chars",
    SESSION_SECRET: "session-secret-must-be-16chars",
    CORS_ORIGINS: "http://localhost:3000",
    FRONTEND_URL: "http://localhost:3000",
    PORT: 3001,
    ALLOWED_GITHUB_LOGINS: "",
  },
  allowedGitHubLogins: [],
}));

import { prisma } from "../src/lib/prisma.js";
import { config } from "../src/config/index.js";
import { createApp } from "../src/app.js";
import {
  LOGIN_RATE_MAX,
  UNKNOWN_CLIENT_KEY,
  _loginFailureCount,
  _resetLoginRateLimit,
  recordLoginFailure,
} from "../src/lib/login-rate-limit.js";

const PANEL = "panel-token-must-be-16chars";
const OLD_PANEL = "old-panel-token-before-rotation";
const CLEAR = "panel_session=; Path=/; HttpOnly; Max-Age=0";

const mApiKey = prisma.apiKey as unknown as { findUnique: ReturnType<typeof vi.fn> };
const mSession = prisma.session as unknown as { findUnique: ReturnType<typeof vi.fn> };

const app = createApp("http://localhost:3000");

const servers = (headers: Record<string, string>) => app.request("/api/servers", { headers });
const check = (headers: Record<string, string>) => app.request("/api/auth/check", { headers });
const failures = () => _loginFailureCount(UNKNOWN_CLIENT_KEY);
const setCookies = (res: Response) => res.headers.getSetCookie();
const block = () => {
  for (let i = 0; i < LOGIN_RATE_MAX; i++) recordLoginFailure(UNKNOWN_CLIENT_KEY);
};

beforeEach(() => {
  vi.clearAllMocks();
  config.PANEL_TOKEN = PANEL;
  _resetLoginRateLimit();
  mApiKey.findUnique.mockResolvedValue(null);
  mSession.findUnique.mockResolvedValue(null);
});

describe("GET /api/auth/check records failed presentations", () => {
  it("a wrong panel_session cookie answers 401, records one failure and clears the cookie", async () => {
    const res = await check({ Cookie: "panel_session=wrong" });
    expect(res.status).toBe(401);
    expect(failures()).toBe(1);
    expect(setCookies(res)).toEqual([CLEAR]);
  });

  it("the correct panel_session cookie answers 200, records nothing and keeps the cookie", async () => {
    const res = await check({ Cookie: `panel_session=${PANEL}` });
    expect(res.status).toBe(200);
    expect(failures()).toBe(0);
    expect(setCookies(res)).toEqual([]);
  });

  it("a wrong Bearer answers 401, records one failure and sets no cookie", async () => {
    const res = await check({ Authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
    expect(failures()).toBe(1);
    expect(setCookies(res)).toEqual([]);
  });

  it("the correct Bearer answers 200 and records nothing", async () => {
    const res = await check({ Authorization: `Bearer ${PANEL}` });
    expect(res.status).toBe(200);
    expect(failures()).toBe(0);
  });

  it("a wrong Bearer next to the correct cookie answers 200 and still records one failure", async () => {
    const res = await check({ Authorization: "Bearer wrong", Cookie: `panel_session=${PANEL}` });
    expect(res.status).toBe(200);
    expect(failures()).toBe(1);
    expect(setCookies(res)).toEqual([]);
  });

  it("a wrong Bearer and a wrong cookie record one failure each", async () => {
    const res = await check({ Authorization: "Bearer wrong", Cookie: "panel_session=wrong" });
    expect(res.status).toBe(401);
    expect(failures()).toBe(2);
    expect(setCookies(res)).toEqual([CLEAR]);
  });

  it("a request without credentials answers 401 and records nothing", async () => {
    const res = await check({});
    expect(res.status).toBe(401);
    expect(failures()).toBe(0);
    expect(setCookies(res)).toEqual([]);
  });

  it("a blocked key answers 429 with Retry-After before comparing, also for the correct Bearer", async () => {
    block();
    const res = await check({ Authorization: `Bearer ${PANEL}` });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(failures()).toBe(LOGIN_RATE_MAX);
    expect(setCookies(res)).toEqual([]);
  });

  it("a blocked key answers 429 for the correct cookie and clears it", async () => {
    block();
    const res = await check({ Cookie: `panel_session=${PANEL}` });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).not.toBeNull();
    expect(setCookies(res)).toEqual([CLEAR]);
    expect(failures()).toBe(LOGIN_RATE_MAX);
  });
});

describe("requireAuth records failed presentations (GET /api/servers)", () => {
  it("a wrong Bearer answers 401 and records one failure", async () => {
    const res = await servers({ Authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
    expect(failures()).toBe(1);
    expect(setCookies(res)).toEqual([]);
  });

  it("the correct Bearer passes and records nothing", async () => {
    const res = await servers({ Authorization: `Bearer ${PANEL}` });
    expect(res.status).toBe(200);
    expect(failures()).toBe(0);
  });

  it("a wrong panel_session cookie answers 401, records one failure and clears the cookie", async () => {
    const res = await servers({ Cookie: "panel_session=wrong" });
    expect(res.status).toBe(401);
    expect(failures()).toBe(1);
    expect(setCookies(res)).toEqual([CLEAR]);
  });

  it("the correct panel_session cookie passes, records nothing and keeps the cookie", async () => {
    const res = await servers({ Cookie: `panel_session=${PANEL}` });
    expect(res.status).toBe(200);
    expect(failures()).toBe(0);
    expect(setCookies(res)).toEqual([]);
  });

  it("a wrong Bearer next to the correct cookie passes and still records one failure", async () => {
    const res = await servers({ Authorization: "Bearer wrong", Cookie: `panel_session=${PANEL}` });
    expect(res.status).toBe(200);
    expect(failures()).toBe(1);
  });

  it("an unknown dp_ key answers 401 and records one failure", async () => {
    const res = await servers({ Authorization: "Bearer dp_unknown" });
    expect(res.status).toBe(401);
    expect(failures()).toBe(1);
  });

  it("a revoked dp_ key answers 401 and records one failure", async () => {
    mApiKey.findUnique.mockResolvedValue({ id: "k1", name: "ci", userId: null, revokedAt: new Date() });
    const res = await servers({ Authorization: "Bearer dp_revoked" });
    expect(res.status).toBe(401);
    expect(failures()).toBe(1);
  });

  it("a valid dp_ key passes and records nothing", async () => {
    mApiKey.findUnique.mockResolvedValue({ id: "k1", name: "ci", userId: null, revokedAt: null });
    const res = await servers({ Authorization: "Bearer dp_valid" });
    expect(res.status).toBe(200);
    expect(failures()).toBe(0);
  });

  it("a user_session without a valid session answers 401 and records one failure", async () => {
    const res = await servers({ Cookie: "user_session=gone" });
    expect(res.status).toBe(401);
    expect(failures()).toBe(1);
    expect(setCookies(res)).toEqual([]);
  });

  it("an expired user_session answers 401 and records one failure", async () => {
    mSession.findUnique.mockResolvedValue({ userId: "u1", expiresAt: new Date(Date.now() - 1000) });
    const res = await servers({ Cookie: "user_session=expired" });
    expect(res.status).toBe(401);
    expect(failures()).toBe(1);
  });

  it("a valid user_session passes and records nothing", async () => {
    mSession.findUnique.mockResolvedValue({ userId: "u1", expiresAt: new Date(Date.now() + 60_000) });
    const res = await servers({ Cookie: "user_session=live" });
    expect(res.status).toBe(200);
    expect(failures()).toBe(0);
  });

  it("a wrong panel_session next to a valid user_session passes, records one failure and clears the panel cookie", async () => {
    mSession.findUnique.mockResolvedValue({ userId: "u1", expiresAt: new Date(Date.now() + 60_000) });
    const res = await servers({ Cookie: "panel_session=wrong; user_session=live" });
    expect(res.status).toBe(200);
    expect(failures()).toBe(1);
    expect(setCookies(res)).toEqual([CLEAR]);
  });

  it("a request without credentials answers 401 and records nothing", async () => {
    const res = await servers({});
    expect(res.status).toBe(401);
    expect(failures()).toBe(0);
    expect(setCookies(res)).toEqual([]);
  });

  it("a successful presentation does not clear earlier failures", async () => {
    recordLoginFailure(UNKNOWN_CLIENT_KEY);
    recordLoginFailure(UNKNOWN_CLIENT_KEY);
    const res = await servers({ Authorization: `Bearer ${PANEL}` });
    expect(res.status).toBe(200);
    expect(failures()).toBe(2);
  });

  it("the tenth failure still answers 401, the next request 429", async () => {
    for (let i = 0; i < LOGIN_RATE_MAX; i++) {
      expect((await servers({ Authorization: "Bearer wrong" })).status).toBe(401);
    }
    const res = await servers({ Authorization: `Bearer ${PANEL}` });
    expect(res.status).toBe(429);
  });
});

describe("requireAuth on a blocked key answers 429 before any comparison", () => {
  beforeEach(() => block());

  it("the correct Bearer", async () => {
    const res = await servers({ Authorization: `Bearer ${PANEL}` });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(setCookies(res)).toEqual([]);
  });

  it("the correct panel_session cookie, which is cleared", async () => {
    const res = await servers({ Cookie: `panel_session=${PANEL}` });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).not.toBeNull();
    expect(setCookies(res)).toEqual([CLEAR]);
  });

  it("a valid dp_ key, without looking it up", async () => {
    mApiKey.findUnique.mockResolvedValue({ id: "k1", name: "ci", userId: null, revokedAt: null });
    const res = await servers({ Authorization: "Bearer dp_valid" });
    expect(res.status).toBe(429);
    expect(mApiKey.findUnique).not.toHaveBeenCalled();
  });

  it("a valid user_session, without looking it up", async () => {
    mSession.findUnique.mockResolvedValue({ userId: "u1", expiresAt: new Date(Date.now() + 60_000) });
    const res = await servers({ Cookie: "user_session=live" });
    expect(res.status).toBe(429);
    expect(mSession.findUnique).not.toHaveBeenCalled();
  });

  it("does not record the blocked requests", async () => {
    await servers({ Authorization: "Bearer wrong" });
    await servers({ Cookie: "panel_session=wrong" });
    expect(failures()).toBe(LOGIN_RATE_MAX);
  });
});

describe("stale panel_session cookie after a PANEL_TOKEN rotation", () => {
  it("one dashboard load (two parallel requests) costs 2 failures, clears the cookie, and the next login succeeds", async () => {
    const cookie = { Cookie: `panel_session=${OLD_PANEL}` };
    const [a, b] = await Promise.all([
      app.request("/api/servers", { headers: cookie }),
      app.request("/api/deploys", { headers: cookie }),
    ]);
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(setCookies(a)).toEqual([CLEAR]);
    expect(setCookies(b)).toEqual([CLEAR]);
    expect(failures()).toBe(2);

    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: PANEL }),
    });
    expect(login.status).toBe(200);
    expect(failures()).toBe(2);
  });
});

describe("without PANEL_TOKEN (development fallback)", () => {
  it("requireAuth and /check do not consult the limiter", async () => {
    config.PANEL_TOKEN = "" as unknown as typeof config.PANEL_TOKEN;
    block();
    expect((await servers({ Authorization: "Bearer wrong" })).status).toBe(200);
    expect((await check({ Cookie: "panel_session=wrong" })).status).toBe(200);
    expect(failures()).toBe(LOGIN_RATE_MAX);
  });
});
