import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    session: { create: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn() },
  },
}));

vi.mock("../src/config/index.js", () => ({
  config: {
    NODE_ENV: "test",
    PANEL_TOKEN: "panel-token-must-be-16chars",
    SESSION_SECRET: "session-secret-must-be-16chars",
    CORS_ORIGINS: "http://localhost:3000",
    FRONTEND_URL: "http://localhost:3000",
    BACKEND_URL: "http://localhost:3001",
    GITHUB_CLIENT_ID: "",
    GITHUB_CLIENT_SECRET: "",
    PORT: 3001,
    ALLOWED_GITHUB_LOGINS: "",
  },
  allowedGitHubLogins: [],
  hasGitHubOAuthConfigured: false,
}));

import { authRouter } from "../src/routes/auth.js";
import {
  LOGIN_RATE_MAX,
  LOGIN_RATE_WINDOW_MS,
  UNKNOWN_CLIENT_KEY,
  _loginRateLimitSize,
  _resetLoginRateLimit,
  checkLoginBlocked,
  isTrustedProxyPeer,
  recordLoginFailure,
  resolveLoginClientKey,
} from "../src/lib/login-rate-limit.js";

const GOOD = "panel-token-must-be-16chars";
const BAD = "wrong-token";

/** Fake @hono/node-server bindings: what getConnInfo reads the peer from. */
function nodeEnv(remoteAddress: string | undefined) {
  return { incoming: { socket: { remoteAddress } } };
}

function login(
  token: string,
  opts: { peer?: string | null; xff?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.xff !== undefined) headers["X-Forwarded-For"] = opts.xff;
  const env = opts.peer === null ? undefined : nodeEnv(opts.peer ?? "203.0.113.7");
  return authRouter.request(
    "/login",
    { method: "POST", headers, body: JSON.stringify({ token }) },
    env,
  );
}

async function failMany(n: number, opts: Parameters<typeof login>[1] = {}): Promise<void> {
  for (let i = 0; i < n; i++) {
    const res = await login(BAD, opts);
    expect(res.status).toBe(401);
  }
}

describe("POST /auth/login rate limit", () => {
  beforeEach(() => {
    _resetLoginRateLimit();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers 401 for every failure while under the limit", async () => {
    await failMany(LOGIN_RATE_MAX);
  });

  it("answers 429 with the rate_limited envelope and Retry-After once the limit is reached", async () => {
    await failMany(LOGIN_RATE_MAX);
    const res = await login(BAD);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("rate_limited");
    expect(typeof body.message).toBe("string");
    const retry = Number(res.headers.get("Retry-After"));
    expect(Number.isInteger(retry)).toBe(true);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(LOGIN_RATE_WINDOW_MS / 1000);
  });

  it("Retry-After counts down to the oldest failure leaving the window", async () => {
    await failMany(LOGIN_RATE_MAX);
    vi.advanceTimersByTime(LOGIN_RATE_WINDOW_MS - 30_000);
    const res = await login(BAD);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("does not count blocked attempts: the block ends when the first failures expire", async () => {
    await failMany(LOGIN_RATE_MAX);
    vi.advanceTimersByTime(LOGIN_RATE_WINDOW_MS - 1_000);
    expect((await login(BAD)).status).toBe(429);
    vi.advanceTimersByTime(2_000);
    expect((await login(BAD)).status).toBe(401);
  });

  it("lets a failure through again after the window has expired", async () => {
    await failMany(LOGIN_RATE_MAX);
    expect((await login(BAD)).status).toBe(429);
    vi.advanceTimersByTime(LOGIN_RATE_WINDOW_MS + 1);
    expect((await login(BAD)).status).toBe(401);
    expect((await login(GOOD)).status).toBe(200);
  });

  it("does not count a successful login", async () => {
    await failMany(LOGIN_RATE_MAX - 1);
    for (let i = 0; i < 5; i++) {
      const ok = await login(GOOD);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ success: true });
    }
    // One failure budget is still left: this is the LOGIN_RATE_MAX-th failure (401, not 429).
    expect((await login(BAD)).status).toBe(401);
    expect((await login(BAD)).status).toBe(429);
  });

  it("blocks a correct token while the key is over the limit (decided before the compare)", async () => {
    await failMany(LOGIN_RATE_MAX);
    const res = await login(GOOD);
    expect(res.status).toBe(429);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("answers a correct token with 200 and the cookie while under the limit", async () => {
    await failMany(LOGIN_RATE_MAX - 1);
    const res = await login(GOOD);
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("panel_session=");
  });

  it("keeps different peers independent", async () => {
    await failMany(LOGIN_RATE_MAX, { peer: "203.0.113.7" });
    expect((await login(BAD, { peer: "203.0.113.7" })).status).toBe(429);
    expect((await login(BAD, { peer: "203.0.113.8" })).status).toBe(401);
    expect((await login(GOOD, { peer: "203.0.113.8" })).status).toBe(200);
  });

  it("does not count a body that fails validation", async () => {
    await failMany(LOGIN_RATE_MAX - 1);
    for (let i = 0; i < 3; i++) {
      const res = await authRouter.request(
        "/login",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        nodeEnv("203.0.113.7"),
      );
      expect(res.status).toBe(400);
    }
    expect((await login(BAD)).status).toBe(401);
  });

  describe("client key", () => {
    it("public peer with a spoofed X-Forwarded-For: the peer is the key", async () => {
      // Rotating XFF values must not buy fresh budgets.
      for (let i = 0; i < LOGIN_RATE_MAX; i++) {
        const res = await login(BAD, { peer: "203.0.113.7", xff: `198.51.100.${i}` });
        expect(res.status).toBe(401);
      }
      const res = await login(BAD, { peer: "203.0.113.7", xff: "198.51.100.200" });
      expect(res.status).toBe(429);
    });

    it("public peer: another peer's X-Forwarded-For is not borrowed", async () => {
      await failMany(LOGIN_RATE_MAX, { peer: "203.0.113.7" });
      // Different peer claiming to be the blocked address via XFF stays unblocked.
      const res = await login(BAD, { peer: "203.0.113.9", xff: "203.0.113.7" });
      expect(res.status).toBe(401);
    });

    it("private peer + X-Forwarded-For: the rightmost entry is the key", async () => {
      await failMany(LOGIN_RATE_MAX, { peer: "172.18.0.2", xff: "198.51.100.1" });
      expect((await login(BAD, { peer: "172.18.0.2", xff: "198.51.100.1" })).status).toBe(429);
      // A second client behind the same proxy has its own budget.
      expect((await login(BAD, { peer: "172.18.0.2", xff: "198.51.100.2" })).status).toBe(401);
      // The proxy peer itself (no header) is a third key.
      expect((await login(BAD, { peer: "172.18.0.2" })).status).toBe(401);
    });

    it("private peer + multi-hop X-Forwarded-For: spoofed left entries do not matter", async () => {
      for (let i = 0; i < LOGIN_RATE_MAX; i++) {
        const res = await login(BAD, {
          peer: "10.0.0.5",
          xff: `192.0.2.${i}, 198.51.100.9`,
        });
        expect(res.status).toBe(401);
      }
      const res = await login(BAD, { peer: "10.0.0.5", xff: "192.0.2.250, 198.51.100.9" });
      expect(res.status).toBe(429);
      // Same left entries but a different rightmost hop: independent.
      const other = await login(BAD, { peer: "10.0.0.5", xff: "192.0.2.250, 198.51.100.10" });
      expect(other.status).toBe(401);
    });

    it("private peer without X-Forwarded-For: the peer is the key", async () => {
      await failMany(LOGIN_RATE_MAX, { peer: "192.168.1.10" });
      expect((await login(BAD, { peer: "192.168.1.10" })).status).toBe(429);
    });

    it("private peer with garbage X-Forwarded-For: falls back to the peer", async () => {
      await failMany(LOGIN_RATE_MAX, { peer: "192.168.1.10", xff: "not-an-ip" });
      expect((await login(BAD, { peer: "192.168.1.10" })).status).toBe(429);
      expect((await login(BAD, { peer: "192.168.1.10", xff: "also garbage" })).status).toBe(429);
    });

    it("IPv4-mapped IPv6 private peer is treated as private", async () => {
      await failMany(LOGIN_RATE_MAX, { peer: "::ffff:172.18.0.2", xff: "198.51.100.1" });
      expect((await login(BAD, { peer: "::ffff:172.18.0.2", xff: "198.51.100.1" })).status).toBe(429);
      expect((await login(BAD, { peer: "::ffff:172.18.0.2", xff: "198.51.100.2" })).status).toBe(401);
    });

    it("no socket info (no node adapter env): one shared key", async () => {
      for (let i = 0; i < LOGIN_RATE_MAX; i++) {
        expect((await login(BAD, { peer: null })).status).toBe(401);
      }
      expect((await login(BAD, { peer: null })).status).toBe(429);
    });
  });
});

describe("resolveLoginClientKey", () => {
  it("public peer wins over any X-Forwarded-For", () => {
    expect(resolveLoginClientKey("203.0.113.7", "198.51.100.1")).toBe("203.0.113.7");
  });

  it("private peer: rightmost entry wins, whitespace trimmed", () => {
    expect(resolveLoginClientKey("10.0.0.1", "1.1.1.1,  198.51.100.9 ")).toBe("198.51.100.9");
  });

  it("loopback peer: rightmost entry wins", () => {
    expect(resolveLoginClientKey("127.0.0.1", "198.51.100.9")).toBe("198.51.100.9");
    expect(resolveLoginClientKey("::1", "198.51.100.9")).toBe("198.51.100.9");
  });

  it("fc00::/7 peer: rightmost entry wins", () => {
    expect(resolveLoginClientKey("fd12:3456::1", "198.51.100.9")).toBe("198.51.100.9");
  });

  it("empty, trailing-comma and malformed headers fall back to the peer", () => {
    expect(resolveLoginClientKey("10.0.0.1", "")).toBe("10.0.0.1");
    expect(resolveLoginClientKey("10.0.0.1", undefined)).toBe("10.0.0.1");
    expect(resolveLoginClientKey("10.0.0.1", null)).toBe("10.0.0.1");
    expect(resolveLoginClientKey("10.0.0.1", "198.51.100.9,")).toBe("10.0.0.1");
    expect(resolveLoginClientKey("10.0.0.1", "198.51.100.9:443")).toBe("10.0.0.1");
    expect(resolveLoginClientKey("10.0.0.1", "unknown")).toBe("10.0.0.1");
  });

  it("IPv6 rightmost entries are accepted and lowercased", () => {
    expect(resolveLoginClientKey("10.0.0.1", "2001:DB8::1")).toBe("2001:db8::1");
  });

  it("a dotted IPv4-mapped address is folded to plain IPv4 on both sides", () => {
    expect(resolveLoginClientKey("::ffff:203.0.113.7", undefined)).toBe("203.0.113.7");
    expect(resolveLoginClientKey("10.0.0.1", "::ffff:198.51.100.9")).toBe("198.51.100.9");
  });

  it("a missing peer maps to the shared unknown key", () => {
    expect(resolveLoginClientKey(undefined, "198.51.100.9")).toBe(UNKNOWN_CLIENT_KEY);
    expect(resolveLoginClientKey("", "198.51.100.9")).toBe(UNKNOWN_CLIENT_KEY);
  });
});

describe("isTrustedProxyPeer", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "::1",
    "fc00::1",
    "fdff::1",
    "::ffff:10.0.0.1",
    "::ffff:a00:1",
  ])("%s is trusted", (addr) => {
    expect(isTrustedProxyPeer(addr)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "172.15.255.255",
    "172.32.0.1",
    "192.169.0.1",
    "11.0.0.1",
    "2001:db8::1",
    "fe80::1",
    "::ffff:8.8.8.8",
    "",
    "not-an-ip",
  ])("%s is not trusted", (addr) => {
    expect(isTrustedProxyPeer(addr)).toBe(false);
  });
});

describe("login failure window", () => {
  beforeEach(() => _resetLoginRateLimit());

  it("blocks at exactly LOGIN_RATE_MAX failures, not before", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < LOGIN_RATE_MAX - 1; i++) recordLoginFailure("k", t0 + i);
    expect(checkLoginBlocked("k", t0 + 100).blocked).toBe(false);
    recordLoginFailure("k", t0 + LOGIN_RATE_MAX);
    expect(checkLoginBlocked("k", t0 + 100).blocked).toBe(true);
  });

  it("a failure exactly one window old no longer counts", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < LOGIN_RATE_MAX; i++) recordLoginFailure("k", t0);
    expect(checkLoginBlocked("k", t0 + LOGIN_RATE_WINDOW_MS - 1).blocked).toBe(true);
    expect(checkLoginBlocked("k", t0 + LOGIN_RATE_WINDOW_MS).blocked).toBe(false);
  });

  it("keys are independent", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < LOGIN_RATE_MAX; i++) recordLoginFailure("a", t0);
    expect(checkLoginBlocked("a", t0).blocked).toBe(true);
    expect(checkLoginBlocked("b", t0).blocked).toBe(false);
  });

  it("prunes expired keys so the map does not grow without bound", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 50; i++) recordLoginFailure(`old-${i}`, t0);
    expect(_loginRateLimitSize()).toBe(50);
    const later = t0 + LOGIN_RATE_WINDOW_MS + 1;
    // The prune runs every 100th check on any key.
    for (let i = 0; i < 100; i++) checkLoginBlocked("fresh", later);
    expect(_loginRateLimitSize()).toBe(0);
  });

  it("an expired key is dropped when checked", () => {
    const t0 = 1_000_000;
    recordLoginFailure("k", t0);
    expect(_loginRateLimitSize()).toBe(1);
    expect(checkLoginBlocked("k", t0 + LOGIN_RATE_WINDOW_MS + 1).blocked).toBe(false);
    expect(_loginRateLimitSize()).toBe(0);
  });
});
