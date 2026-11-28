/**
 * The `panel_session` cookie holds a random, server-side, individually
 * revocable admin session token (lib/panel-session.ts), never the
 * PANEL_TOKEN. The PANEL_TOKEN stays the login secret and a Bearer
 * credential only.
 *
 * Part 1 pins the in-memory store with an injected clock and cap. Part 2 runs
 * the flow through the app: login, use of the cookie, logout, expiry, the
 * refusal of the raw PANEL_TOKEN as a cookie and of a session token as a
 * Bearer. The failure-budget rules for failed presentations are pinned in
 * auth-presentation-rate-limit.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
    deploy: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    apiKey: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    session: { findUnique: vi.fn().mockResolvedValue(null), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
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

import { config } from "../src/config/index.js";
import { createApp } from "../src/app.js";
import {
  LOGIN_RATE_MAX,
  UNKNOWN_CLIENT_KEY,
  _loginFailureCount,
  _resetLoginRateLimit,
  recordLoginFailure,
} from "../src/lib/login-rate-limit.js";
import {
  PANEL_SESSION_MAX_ENTRIES,
  PANEL_SESSION_TTL_MS,
  _panelSessionCount,
  _resetPanelSessions,
  buildPanelSessionCookie,
  createPanelSessionStore,
} from "../src/lib/panel-session.js";

const PANEL = "panel-token-must-be-16chars";
const CLEAR = "panel_session=; Path=/; HttpOnly; Max-Age=0";

describe("panel session store", () => {
  const clock = (start = 1_000_000) => {
    let t = start;
    return { now: () => t, advance: (ms: number) => void (t += ms), set: (v: number) => void (t = v) };
  };

  it("issues 32 random bytes as 64 hex characters, a different one each time", () => {
    const store = createPanelSessionStore();
    const a = store.create();
    const b = store.create();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("accepts an issued token and refuses unknown, empty and near-miss values", () => {
    const store = createPanelSessionStore();
    const token = store.create();
    expect(store.validate(token)).toBe(true);
    expect(store.validate("")).toBe(false);
    expect(store.validate("0".repeat(64))).toBe(false);
    expect(store.validate(token.slice(0, -1))).toBe(false);
    expect(store.validate(`${token}x`)).toBe(false);
    expect(store.validate(token.toUpperCase())).toBe(false);
  });

  it("revoke makes the token invalid, leaves the others and ignores unknown tokens", () => {
    const store = createPanelSessionStore();
    const a = store.create();
    const b = store.create();
    store.revoke(a);
    expect(store.validate(a)).toBe(false);
    expect(store.validate(b)).toBe(true);
    expect(() => store.revoke(a)).not.toThrow();
    expect(() => store.revoke("")).not.toThrow();
    expect(() => store.revoke("unknown")).not.toThrow();
    expect(store.size()).toBe(1);
  });

  it("expires a session exactly at the TTL (injected clock, no sleeping)", () => {
    const c = clock();
    const store = createPanelSessionStore({ ttlMs: 1000, now: c.now });
    const token = store.create();
    c.advance(999);
    expect(store.validate(token)).toBe(true);
    c.advance(1);
    expect(store.validate(token)).toBe(false);
    expect(store.size()).toBe(0);
  });

  it("an expired session stays refused when the clock is not moved back", () => {
    const c = clock();
    const store = createPanelSessionStore({ ttlMs: 1000, now: c.now });
    const token = store.create();
    c.advance(5000);
    expect(store.validate(token)).toBe(false);
    expect(store.validate(token)).toBe(false);
  });

  it("defaults to a 24 hour TTL and a 1000 entry cap", () => {
    expect(PANEL_SESSION_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(PANEL_SESSION_MAX_ENTRIES).toBe(1000);
    const c = clock();
    const store = createPanelSessionStore({ now: c.now });
    const token = store.create();
    c.advance(PANEL_SESSION_TTL_MS - 1);
    expect(store.validate(token)).toBe(true);
    c.advance(1);
    expect(store.validate(token)).toBe(false);
  });

  it("stays bounded: at the cap the oldest live session is evicted", () => {
    const c = clock();
    const store = createPanelSessionStore({ ttlMs: 10_000, maxEntries: 3, now: c.now });
    const tokens: string[] = [];
    for (let i = 0; i < 5; i++) {
      tokens.push(store.create());
      c.advance(1);
      expect(store.size()).toBeLessThanOrEqual(3);
    }
    expect(store.size()).toBe(3);
    expect(store.validate(tokens[0])).toBe(false);
    expect(store.validate(tokens[1])).toBe(false);
    expect(store.validate(tokens[2])).toBe(true);
    expect(store.validate(tokens[3])).toBe(true);
    expect(store.validate(tokens[4])).toBe(true);
  });

  it("at the cap expired sessions are dropped before any live one is evicted", () => {
    const c = clock();
    const store = createPanelSessionStore({ ttlMs: 1000, maxEntries: 2, now: c.now });
    const first = store.create();
    c.advance(600);
    const second = store.create();
    c.advance(600); // first has expired, second has not
    const third = store.create();
    expect(store.validate(first)).toBe(false);
    expect(store.validate(second)).toBe(true);
    expect(store.validate(third)).toBe(true);
    expect(store.size()).toBe(2);
  });

  it("issuing a session drops the expired ones, so idle entries do not pile up below the cap", () => {
    const c = clock();
    const store = createPanelSessionStore({ ttlMs: 1000, maxEntries: 100, now: c.now });
    store.create();
    store.create();
    expect(store.size()).toBe(2);
    c.advance(1000);
    const live = store.create();
    expect(store.size()).toBe(1);
    expect(store.validate(live)).toBe(true);
  });

  it("clear forgets every session", () => {
    const store = createPanelSessionStore();
    const token = store.create();
    store.clear();
    expect(store.validate(token)).toBe(false);
    expect(store.size()).toBe(0);
  });

  it("builds a Strict, HttpOnly cookie with a 24 hour Max-Age, Secure only on request", () => {
    expect(buildPanelSessionCookie("abc", false)).toBe(
      "panel_session=abc; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400",
    );
    expect(buildPanelSessionCookie("abc", true)).toBe(
      "panel_session=abc; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400; Secure",
    );
  });
});

describe("admin session flow through the app", () => {
  const app = createApp("http://localhost:3000");
  const post = (path: string, headers: Record<string, string> = {}, body?: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = (token: string = PANEL, headers: Record<string, string> = {}) =>
    post("/api/auth/login", headers, { token });
  const servers = (headers: Record<string, string>) => app.request("/api/servers", { headers });
  const check = (headers: Record<string, string>) => app.request("/api/auth/check", { headers });
  const setCookies = (res: Response) => res.headers.getSetCookie();
  /** The `panel_session` value a response sets. */
  const sessionOf = (res: Response): string => {
    const header = setCookies(res).find((c) => c.startsWith("panel_session="));
    expect(header).toBeDefined();
    return header!.slice("panel_session=".length).split(";")[0];
  };
  const cookie = (token: string) => ({ Cookie: `panel_session=${token}` });
  const failures = () => _loginFailureCount(UNKNOWN_CLIENT_KEY);

  beforeEach(() => {
    config.PANEL_TOKEN = PANEL;
    config.NODE_ENV = "test";
    _resetLoginRateLimit();
    _resetPanelSessions();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("POST /api/auth/login", () => {
    it("sets a random session token, never the PANEL_TOKEN, with the cookie attributes of before", async () => {
      const res = await login();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      const [header, ...rest] = setCookies(res);
      expect(rest).toEqual([]);
      const token = sessionOf(res);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(token).not.toBe(PANEL);
      expect(header).not.toContain(PANEL);
      expect(header).toBe(`panel_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
    });

    it("adds Secure in production", async () => {
      config.NODE_ENV = "production" as typeof config.NODE_ENV;
      const res = await login();
      expect(setCookies(res)[0]).toMatch(/; Max-Age=86400; Secure$/);
    });

    it("two logins yield two different sessions, both live", async () => {
      const a = sessionOf(await login());
      const b = sessionOf(await login());
      expect(a).not.toBe(b);
      expect((await servers(cookie(a))).status).toBe(200);
      expect((await servers(cookie(b))).status).toBe(200);
    });

    it("a login that presents a live session revokes it and issues a new one", async () => {
      const old = sessionOf(await login());
      const fresh = sessionOf(await login(PANEL, cookie(old)));
      expect(fresh).not.toBe(old);
      expect((await servers(cookie(old))).status).toBe(401);
      expect((await servers(cookie(fresh))).status).toBe(200);
      expect(_panelSessionCount()).toBe(1);
    });

    it("a login that presents the raw PANEL_TOKEN as cookie still succeeds and issues a session", async () => {
      const res = await login(PANEL, cookie(PANEL));
      expect(res.status).toBe(200);
      expect(sessionOf(res)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("a wrong token answers 401, sets no cookie, creates no session and records one failure", async () => {
      const res = await login("wrong");
      expect(res.status).toBe(401);
      expect(setCookies(res)).toEqual([]);
      expect(_panelSessionCount()).toBe(0);
      expect(failures()).toBe(1);
    });

    it("a blocked key answers 429, sets no cookie and creates no session, also for the right token", async () => {
      for (let i = 0; i < LOGIN_RATE_MAX; i++) recordLoginFailure(UNKNOWN_CLIENT_KEY);
      const res = await login();
      expect(res.status).toBe(429);
      expect(setCookies(res)).toEqual([]);
      expect(_panelSessionCount()).toBe(0);
    });

    it("a successful login records no failure", async () => {
      await login();
      expect(failures()).toBe(0);
    });
  });

  describe("using the cookie", () => {
    it("requireAuth and /check accept the session cookie, which stays set and costs nothing", async () => {
      const token = sessionOf(await login());
      const gated = await servers(cookie(token));
      expect(gated.status).toBe(200);
      expect(setCookies(gated)).toEqual([]);
      const checked = await check(cookie(token));
      expect(checked.status).toBe(200);
      expect(await checked.json()).toEqual({ authenticated: true });
      expect(failures()).toBe(0);
    });

    it("the session is admin: the api-keys gate lets it through", async () => {
      const token = sessionOf(await login());
      const res = await app.request("/api/api-keys", { headers: cookie(token) });
      expect(res.status).toBe(200);
    });

    it("the raw PANEL_TOKEN as cookie is refused by requireAuth: 401, one failure, cookie cleared", async () => {
      const res = await servers(cookie(PANEL));
      expect(res.status).toBe(401);
      expect(failures()).toBe(1);
      expect(setCookies(res)).toEqual([CLEAR]);
    });

    it("the raw PANEL_TOKEN as cookie is refused by /check: 401, one failure, cookie cleared", async () => {
      const res = await check(cookie(PANEL));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ authenticated: false });
      expect(failures()).toBe(1);
      expect(setCookies(res)).toEqual([CLEAR]);
    });

    it("the raw PANEL_TOKEN as cookie is refused on the api-keys gate", async () => {
      const res = await app.request("/api/api-keys", { headers: cookie(PANEL) });
      expect(res.status).toBe(401);
    });

    it("a session token as Bearer is refused: 401 and one failure, on requireAuth and /check", async () => {
      const token = sessionOf(await login());
      const gated = await servers({ Authorization: `Bearer ${token}` });
      expect(gated.status).toBe(401);
      expect(failures()).toBe(1);
      const checked = await check({ Authorization: `Bearer ${token}` });
      expect(checked.status).toBe(401);
      expect(failures()).toBe(2);
      // The refusal does not revoke the session: it still works as a cookie.
      expect((await servers(cookie(token))).status).toBe(200);
    });

    it("the PANEL_TOKEN as Bearer still passes as the panel credential", async () => {
      const gated = await servers({ Authorization: `Bearer ${PANEL}` });
      expect(gated.status).toBe(200);
      expect((await check({ Authorization: `Bearer ${PANEL}` })).status).toBe(200);
      expect(failures()).toBe(0);
    });

    it("an unknown session is refused with a cleared cookie and one failure", async () => {
      const res = await servers(cookie("0".repeat(64)));
      expect(res.status).toBe(401);
      expect(failures()).toBe(1);
      expect(setCookies(res)).toEqual([CLEAR]);
    });
  });

  describe("POST /api/auth/logout", () => {
    it("revokes the session: the same cookie is refused afterwards", async () => {
      const token = sessionOf(await login());
      expect((await servers(cookie(token))).status).toBe(200);
      const res = await post("/api/auth/logout", cookie(token));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(setCookies(res)).toContain(CLEAR);
      expect(_panelSessionCount()).toBe(0);
      expect((await servers(cookie(token))).status).toBe(401);
      expect((await check(cookie(token))).status).toBe(401);
    });

    it("answers 200 for a missing, unknown or already revoked cookie", async () => {
      const token = sessionOf(await login());
      expect((await post("/api/auth/logout")).status).toBe(200);
      expect((await post("/api/auth/logout", cookie("0".repeat(64)))).status).toBe(200);
      expect((await post("/api/auth/logout", cookie(token))).status).toBe(200);
      expect((await post("/api/auth/logout", cookie(token))).status).toBe(200);
    });

    it("logging out one admin leaves the other session live", async () => {
      const a = sessionOf(await login());
      const b = sessionOf(await login());
      await post("/api/auth/logout", cookie(a));
      expect((await servers(cookie(b))).status).toBe(200);
    });
  });

  describe("expiry", () => {
    it("a session is live until 24 hours after login and refused from then on", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
      const token = sessionOf(await login());

      vi.setSystemTime(new Date("2030-01-01T00:00:00Z").getTime() + PANEL_SESSION_TTL_MS - 1);
      expect((await servers(cookie(token))).status).toBe(200);

      vi.setSystemTime(new Date("2030-01-01T00:00:00Z").getTime() + PANEL_SESSION_TTL_MS);
      const res = await servers(cookie(token));
      expect(res.status).toBe(401);
      expect(setCookies(res)).toEqual([CLEAR]);
      expect(failures()).toBe(1);
      expect((await check(cookie(token))).status).toBe(401);
    });
  });

  describe("without PANEL_TOKEN (development fallback)", () => {
    it("login still refuses and creates no session", async () => {
      config.PANEL_TOKEN = "" as unknown as typeof config.PANEL_TOKEN;
      const res = await login(PANEL);
      expect(res.status).toBe(401);
      expect(_panelSessionCount()).toBe(0);
    });
  });
});
