import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => {
  const apiKey = {
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    create: vi.fn().mockResolvedValue({}),
  };
  return {
    prisma: {
      user: { upsert: vi.fn() },
      apiKey: Object.assign(apiKey, { findUnique: vi.fn().mockResolvedValue(null) }),
      server: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
      session: { findUnique: vi.fn().mockResolvedValue(null) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = { $executeRaw: vi.fn().mockResolvedValue(0), apiKey };
        return fn(tx);
      }),
    },
  };
});

vi.mock("../src/lib/github.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github.js")>(
    "../src/lib/github.js",
  );
  return { ...actual, fetchGitHubUser: vi.fn() };
});

const { allowedLoginsMock } = vi.hoisted(() => ({ allowedLoginsMock: [] as string[] }));
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
  allowedGitHubLogins: allowedLoginsMock,
}));

import { prisma } from "../src/lib/prisma.js";
import {
  fetchGitHubUser,
  GitHubAuthError,
  GitHubUnreachableError,
} from "../src/lib/github.js";
import { authRouter } from "../src/routes/auth.js";
import { createApp } from "../src/app.js";
import {
  LOGIN_RATE_MAX,
  LOGIN_RATE_WINDOW_MS,
  UNKNOWN_CLIENT_KEY,
  _loginFailureCount,
  _resetLoginRateLimit,
  recordLoginFailure,
} from "../src/lib/login-rate-limit.js";

const mockedFetch = vi.mocked(fetchGitHubUser);
const mUser = prisma.user as unknown as { upsert: ReturnType<typeof vi.fn> };

// Direct app.request() calls carry no socket address, so both limiters see
// the shared "unknown" client; the register budget is the namespaced key.
const REGISTER_KEY = `register:${UNKNOWN_CLIENT_KEY}`;
const LOGIN_KEY = UNKNOWN_CLIENT_KEY;

function call(body: unknown) {
  return authRouter.request("/register-from-project-pilot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function fill(key: string, n = LOGIN_RATE_MAX) {
  for (let i = 0; i < n; i++) recordLoginFailure(key);
}

describe("register-from-project-pilot failure budget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFetch.mockReset();
    mUser.upsert.mockReset();
    _resetLoginRateLimit();
    allowedLoginsMock.length = 0;
  });

  it("answers 429 with Retry-After and makes no GitHub call once the budget is spent", async () => {
    fill(REGISTER_KEY);
    const res = await call({ githubAccessToken: "gho_x" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe(String(LOGIN_RATE_WINDOW_MS / 1000));
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(mUser.upsert).not.toHaveBeenCalled();
  });

  it("still serves a client one failure below the limit", async () => {
    fill(REGISTER_KEY, LOGIN_RATE_MAX - 1);
    mockedFetch.mockRejectedValueOnce(new GitHubAuthError("bad"));
    const res = await call({ githubAccessToken: "gho_x" });
    expect(res.status).toBe(401);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    // that failure was the tenth: the next request is refused
    const next = await call({ githubAccessToken: "gho_x" });
    expect(next.status).toBe(429);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it("counts one failure for a GitHub 401", async () => {
    mockedFetch.mockRejectedValueOnce(new GitHubAuthError("bad"));
    const res = await call({ githubAccessToken: "gho_x" });
    expect(res.status).toBe(401);
    expect(_loginFailureCount(REGISTER_KEY)).toBe(1);
  });

  it("counts one failure for a claimed-login mismatch", async () => {
    mockedFetch.mockResolvedValueOnce({
      id: 1,
      login: "lan",
      email: null,
      avatar_url: "",
    } as never);
    const res = await call({ githubAccessToken: "gho_x", githubLogin: "other" });
    expect(res.status).toBe(401);
    expect(_loginFailureCount(REGISTER_KEY)).toBe(1);
  });

  it("counts one failure for an allowlist refusal", async () => {
    allowedLoginsMock.push("someone-else");
    mockedFetch.mockResolvedValueOnce({
      id: 1,
      login: "lan",
      email: null,
      avatar_url: "",
    } as never);
    const res = await call({ githubAccessToken: "gho_x" });
    expect(res.status).toBe(403);
    expect(_loginFailureCount(REGISTER_KEY)).toBe(1);
  });

  it("counts nothing for a malformed body (400)", async () => {
    const res = await call({ githubLogin: "lan" });
    expect(res.status).toBe(400);
    expect(_loginFailureCount(REGISTER_KEY)).toBe(0);
  });

  it("counts nothing when GitHub is unreachable (503)", async () => {
    mockedFetch.mockRejectedValueOnce(new GitHubUnreachableError("down"));
    const res = await call({ githubAccessToken: "gho_x" });
    expect(res.status).toBe(503);
    expect(_loginFailureCount(REGISTER_KEY)).toBe(0);
  });

  it("counts nothing for an unexpected error (500)", async () => {
    mockedFetch.mockRejectedValueOnce(new Error("boom"));
    const res = await call({ githubAccessToken: "gho_x" });
    expect(res.status).toBe(500);
    expect(_loginFailureCount(REGISTER_KEY)).toBe(0);
  });

  it("counts nothing for a successful registration (200)", async () => {
    mockedFetch.mockResolvedValueOnce({
      id: 1,
      login: "lan",
      email: null,
      avatar_url: "",
    } as never);
    mUser.upsert.mockResolvedValueOnce({ id: "u1" });
    const res = await call({ githubAccessToken: "gho_x", githubLogin: "lan" });
    expect(res.status).toBe(200);
    expect(_loginFailureCount(REGISTER_KEY)).toBe(0);
  });

  it("registration failures driven through the route do not block /login, /check or a requireAuth route", async () => {
    mockedFetch.mockRejectedValue(new GitHubAuthError("bad"));
    for (let i = 0; i < LOGIN_RATE_MAX; i++) {
      expect((await call({ githubAccessToken: "gho_x" })).status).toBe(401);
    }
    expect((await call({ githubAccessToken: "gho_x" })).status).toBe(429);
    expect(_loginFailureCount(REGISTER_KEY)).toBe(LOGIN_RATE_MAX);
    expect(_loginFailureCount(LOGIN_KEY)).toBe(0);

    const app = createApp("http://localhost:3000");
    const PANEL = "panel-token-must-be-16chars";
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: PANEL }),
    });
    expect(login.status).toBe(200);
    const check = await app.request("/api/auth/check", {
      headers: { Authorization: `Bearer ${PANEL}` },
    });
    expect(check.status).toBe(200);
    const servers = await app.request("/api/servers", {
      headers: { Authorization: `Bearer ${PANEL}` },
    });
    expect(servers.status).toBe(200);
    // an unknown dp_ key is a plain 401 on the login budget, never the register 429
    const bad = await app.request("/api/servers", { headers: { Authorization: "Bearer dp_nope" } });
    expect(bad.status).toBe(401);
    expect(_loginFailureCount(LOGIN_KEY)).toBe(1);
  });

  it("login failures do not block registration", async () => {
    fill(LOGIN_KEY);
    mockedFetch.mockResolvedValueOnce({
      id: 1,
      login: "lan",
      email: null,
      avatar_url: "",
    } as never);
    mUser.upsert.mockResolvedValueOnce({ id: "u1" });
    const res = await call({ githubAccessToken: "gho_x" });
    expect(res.status).toBe(200);
  });

  it("Retry-After counts down to the oldest failure leaving the window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = new Date("2030-01-01T00:00:00Z").getTime();
      vi.setSystemTime(t0);
      fill(REGISTER_KEY);
      vi.setSystemTime(t0 + LOGIN_RATE_WINDOW_MS - 30_000);
      const res = await call({ githubAccessToken: "gho_x" });
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("30");
    } finally {
      vi.useRealTimers();
    }
  });

  describe("concurrent bursts", () => {
    const N = 50;
    const delayed = <T,>(fn: () => Promise<T>) => () =>
      new Promise<T>((resolve, reject) => setTimeout(() => fn().then(resolve, reject), 20));
    const okUser = { id: 1, login: "lan", email: null, avatar_url: "" } as never;

    it("a burst of failing registrations reaches GitHub at most LOGIN_RATE_MAX times", async () => {
      mockedFetch.mockImplementation(delayed(() => Promise.reject(new GitHubAuthError("bad"))));
      const res = await Promise.all(
        Array.from({ length: N }, () => call({ githubAccessToken: "gho_x" })),
      );
      const statuses = res.map((r) => r.status);
      expect(statuses.filter((s) => s === 401)).toHaveLength(LOGIN_RATE_MAX);
      expect(statuses.filter((s) => s === 429)).toHaveLength(N - LOGIN_RATE_MAX);
      expect(mockedFetch).toHaveBeenCalledTimes(LOGIN_RATE_MAX);
      expect(_loginFailureCount(REGISTER_KEY)).toBe(LOGIN_RATE_MAX);
    });

    it("a burst of successes leaves no failure recorded", async () => {
      mockedFetch.mockImplementation(delayed(() => Promise.resolve(okUser)));
      mUser.upsert.mockResolvedValue({ id: "u1" });
      const res = await Promise.all(
        Array.from({ length: LOGIN_RATE_MAX - 1 }, () => call({ githubAccessToken: "gho_x" })),
      );
      expect(res.every((r) => r.status === 200)).toBe(true);
      expect(_loginFailureCount(REGISTER_KEY)).toBe(0);
    });

    it("LOGIN_RATE_MAX + 1 concurrent successes give exactly one 429 and leave count 0", async () => {
      mockedFetch.mockImplementation(delayed(() => Promise.resolve(okUser)));
      mUser.upsert.mockResolvedValue({ id: "u1" });
      const res = await Promise.all(
        Array.from({ length: LOGIN_RATE_MAX + 1 }, () => call({ githubAccessToken: "gho_x" })),
      );
      const statuses = res.map((r) => r.status);
      expect(statuses.filter((s) => s === 429)).toHaveLength(1);
      expect(statuses.filter((s) => s === 200)).toHaveLength(LOGIN_RATE_MAX);
      expect(_loginFailureCount(REGISTER_KEY)).toBe(0);
    });

    it("k counted failures then several successes leave the count at k", async () => {
      const k = 3;
      mockedFetch.mockRejectedValue(new GitHubAuthError("bad"));
      for (let i = 0; i < k; i++) {
        expect((await call({ githubAccessToken: "gho_x" })).status).toBe(401);
      }
      mockedFetch.mockReset();
      mockedFetch.mockResolvedValue(okUser);
      mUser.upsert.mockResolvedValue({ id: "u1" });
      for (let i = 0; i < 4; i++) {
        expect((await call({ githubAccessToken: "gho_x" })).status).toBe(200);
      }
      expect(_loginFailureCount(REGISTER_KEY)).toBe(k);
    });

    it("a 2xx GitHub body without a login answers 500 and leaves no failure recorded", async () => {
      mockedFetch.mockResolvedValueOnce({} as never);
      // The claimed login makes the request reach the mismatch check if the
      // route lets the body through; the route's own 500 body tells it apart
      // from the global handler's internal_error.
      const res = await call({ githubAccessToken: "gho_x", githubLogin: "lan" });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal" });
      expect(_loginFailureCount(REGISTER_KEY)).toBe(0);
      expect(mUser.upsert).not.toHaveBeenCalled();
    });

    it("a 2xx GitHub body with an empty login answers 500 and leaves no failure recorded", async () => {
      mockedFetch.mockResolvedValueOnce({ id: 1, login: "" } as never);
      const res = await call({ githubAccessToken: "gho_x", githubLogin: "lan" });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal" });
      expect(_loginFailureCount(REGISTER_KEY)).toBe(0);
      expect(mUser.upsert).not.toHaveBeenCalled();
    });

    it("a burst of 503s leaves no failure recorded", async () => {
      mockedFetch.mockImplementation(
        delayed(() => Promise.reject(new GitHubUnreachableError("down"))),
      );
      const res = await Promise.all(
        Array.from({ length: LOGIN_RATE_MAX - 1 }, () => call({ githubAccessToken: "gho_x" })),
      );
      expect(res.every((r) => r.status === 503)).toBe(true);
      expect(_loginFailureCount(REGISTER_KEY)).toBe(0);
    });

    it("a burst of 500s leaves no failure recorded", async () => {
      mockedFetch.mockImplementation(delayed(() => Promise.reject(new Error("boom"))));
      const res = await Promise.all(
        Array.from({ length: LOGIN_RATE_MAX - 1 }, () => call({ githubAccessToken: "gho_x" })),
      );
      expect(res.every((r) => r.status === 500)).toBe(true);
      expect(_loginFailureCount(REGISTER_KEY)).toBe(0);
    });
  });
});
