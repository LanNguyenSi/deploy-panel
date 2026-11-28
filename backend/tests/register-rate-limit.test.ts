import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => {
  const apiKey = {
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    create: vi.fn().mockResolvedValue({}),
  };
  return {
    prisma: {
      user: { upsert: vi.fn() },
      apiKey,
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
import {
  LOGIN_RATE_MAX,
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
    _resetLoginRateLimit();
    allowedLoginsMock.length = 0;
  });

  it("answers 429 with Retry-After and makes no GitHub call once the budget is spent", async () => {
    fill(REGISTER_KEY);
    const res = await call({ githubAccessToken: "gho_x" });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
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

  it("registration failures do not block /login or spend the login budget", async () => {
    fill(REGISTER_KEY);
    const res = await authRouter.request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong-token-value-1234" }),
    });
    expect(res.status).not.toBe(429);
    expect(_loginFailureCount(LOGIN_KEY)).toBeLessThanOrEqual(1);
    expect(_loginFailureCount(REGISTER_KEY)).toBe(LOGIN_RATE_MAX);
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
});
