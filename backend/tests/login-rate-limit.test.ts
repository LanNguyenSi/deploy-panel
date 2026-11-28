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
  LOGIN_RATE_MAX_KEYS,
  LOGIN_RATE_WINDOW_MS,
  UNKNOWN_CLIENT_KEY,
  _loginFailureCount,
  _loginRateLimitHas,
  _loginRateLimitSize,
  _resetLoginRateLimit,
  checkLoginBlocked,
  isTrustedProxyPeer,
  recordLoginFailure,
  refundLoginFailure,
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

    it("no readable peer: rotating X-Forwarded-For does not buy fresh budgets", async () => {
      for (let i = 0; i < LOGIN_RATE_MAX; i++) {
        expect((await login(BAD, { peer: null, xff: `198.51.100.${i}` })).status).toBe(401);
      }
      expect((await login(BAD, { peer: null, xff: "198.51.100.200" })).status).toBe(429);
      expect((await login(BAD, { peer: null })).status).toBe(429);
    });

    it("an IPv6 peer is limited per /64: rotating the interface id does not help", async () => {
      for (let i = 0; i < LOGIN_RATE_MAX; i++) {
        expect((await login(BAD, { peer: `2001:db8:1:2::${i + 1}` })).status).toBe(401);
      }
      expect((await login(BAD, { peer: "2001:db8:1:2:aaaa:bbbb:cccc:dddd" })).status).toBe(429);
      expect((await login(BAD, { peer: "2001:db8:1:3::1" })).status).toBe(401);
    });

    it("no readable peer (no node adapter env, or a reset connection): one shared key", async () => {
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

  it("IPv6 rightmost entries are accepted, lowercased and keyed by /64", () => {
    expect(resolveLoginClientKey("10.0.0.1", "2001:DB8::1")).toBe("2001:db8:0:0::/64");
  });

  it("IPv6 peers share a bucket inside one /64 and not across /64s", () => {
    const a = resolveLoginClientKey("2001:db8:1:2::1", undefined);
    expect(resolveLoginClientKey("2001:db8:1:2:ffff:ffff:ffff:ffff", undefined)).toBe(a);
    expect(resolveLoginClientKey("2001:DB8:1:2:0:0:0:9", undefined)).toBe(a);
    expect(resolveLoginClientKey("2001:db8:1:3::1", undefined)).not.toBe(a);
    expect(resolveLoginClientKey("2001:db8:2:2::1", undefined)).not.toBe(a);
    expect(a).toBe("2001:db8:1:2::/64");
  });

  it("IPv6 forwarded entries share a bucket inside one /64 and not across /64s", () => {
    const a = resolveLoginClientKey("10.0.0.1", "2001:db8:1:2::1");
    expect(resolveLoginClientKey("10.0.0.1", "2001:db8:1:2::abcd")).toBe(a);
    expect(resolveLoginClientKey("10.0.0.1", "2001:db8:1:3::1")).not.toBe(a);
  });

  it("IPv4-mapped IPv6 stays per IPv4 address, in dotted and hex spelling", () => {
    expect(resolveLoginClientKey("::ffff:203.0.113.7", undefined)).toBe("203.0.113.7");
    expect(resolveLoginClientKey("::ffff:cb00:7107", undefined)).toBe("203.0.113.7");
    expect(resolveLoginClientKey("::ffff:203.0.113.8", undefined)).toBe("203.0.113.8");
    expect(resolveLoginClientKey("10.0.0.1", "::ffff:c633:6409")).toBe("198.51.100.9");
  });

  it("an address that is not ::ffff:a.b.c.d is not folded to IPv4", () => {
    const zeros = "0:0:0:0::/64";
    // A non-zero fifth group before ffff keeps the IPv6 /64 key.
    expect(resolveLoginClientKey("::1:ffff:cb00:7107", undefined)).toBe(zeros);
    expect(resolveLoginClientKey("10.0.0.1", "::1:ffff:c633:6409")).toBe(zeros);
    // A non-zero group anywhere in the first four does too.
    expect(resolveLoginClientKey("1::ffff:cb00:7107", undefined)).toBe("1:0:0:0::/64");
    expect(resolveLoginClientKey("0:0:0:1:0:ffff:cb00:7107", undefined)).toBe("0:0:0:1::/64");
    // The sixth group must be ffff.
    expect(resolveLoginClientKey("::fffe:cb00:7107", undefined)).toBe(zeros);
  });

  it("an IPv6 zone id never reaches the key", () => {
    expect(resolveLoginClientKey("10.0.0.1", "fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(resolveLoginClientKey("10.0.0.1", "fe80::%eth0")).toBe("fe80:0:0:0::/64");
    expect(resolveLoginClientKey("10.0.0.1", "2001:db8::1%25eth0")).toBe("2001:db8:0:0::/64");
    expect(resolveLoginClientKey("fe80::1%lo0", undefined)).toBe("fe80:0:0:0::/64");
    expect(resolveLoginClientKey("fe80::%lo0", undefined)).toBe("fe80:0:0:0::/64");
  });

  it("a zone id is accepted on an IPv6 literal only: an IPv4 entry with % falls back to the peer", () => {
    expect(resolveLoginClientKey("10.0.0.1", "198.51.100.1%x")).toBe("10.0.0.1");
    expect(resolveLoginClientKey("10.0.0.1", `198.51.100.1%${"a".repeat(200)}`)).toBe("10.0.0.1");
    expect(resolveLoginClientKey("10.0.0.1", "not-an-ip%eth0")).toBe("10.0.0.1");
    expect(resolveLoginClientKey("10.0.0.1", "%eth0")).toBe("10.0.0.1");
  });

  it("a forwarded IPv4 entry without % is still used", () => {
    expect(resolveLoginClientKey("10.0.0.1", "198.51.100.1")).toBe("198.51.100.1");
  });

  it("IPv4 peers stay per address", () => {
    expect(resolveLoginClientKey("203.0.113.7", undefined)).not.toBe(
      resolveLoginClientKey("203.0.113.8", undefined),
    );
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

  it("pins the limits at 10 failures per 15 minutes", () => {
    expect(LOGIN_RATE_MAX).toBe(10);
    expect(LOGIN_RATE_WINDOW_MS).toBe(900_000);
    expect(LOGIN_RATE_MAX_KEYS).toBe(10_000);
  });

  it("a blocked key stays blocked across prune passes triggered by other keys", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < LOGIN_RATE_MAX; i++) recordLoginFailure("k", t0);
    // 250 checks trigger the periodic prune twice.
    for (let i = 0; i < 250; i++) expect(checkLoginBlocked("other", t0 + 5).blocked).toBe(false);
    expect(checkLoginBlocked("k", t0 + 10).blocked).toBe(true);
    expect(_loginRateLimitHas("k")).toBe(true);
  });

  it("a live key with a few failures survives a prune pass", () => {
    const t0 = 1_000_000;
    recordLoginFailure("live", t0);
    for (let i = 0; i < 100; i++) checkLoginBlocked("other", t0 + 5);
    expect(_loginRateLimitHas("live")).toBe(true);
  });

  it("Retry-After is measured from the oldest failure when failures are spread over time", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < LOGIN_RATE_MAX; i++) recordLoginFailure("k", t0 + i * 60_000);
    // Oldest leaves at t0 + 15 min; now = t0 + 9 min + 0.5 s: 359.5 s, rounded up.
    const r = checkLoginBlocked("k", t0 + 9 * 60_000 + 500);
    expect(r.blocked).toBe(true);
    expect(r.retryAfterSec).toBe(360);
  });

  it("Retry-After rounds a fractional remainder up, not down", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < LOGIN_RATE_MAX; i++) recordLoginFailure("k", t0);
    expect(checkLoginBlocked("k", t0 + LOGIN_RATE_WINDOW_MS - 1_500).retryAfterSec).toBe(2);
    expect(checkLoginBlocked("k", t0 + LOGIN_RATE_WINDOW_MS - 1_000).retryAfterSec).toBe(1);
    expect(checkLoginBlocked("k", t0 + LOGIN_RATE_WINDOW_MS - 1).retryAfterSec).toBe(1);
  });

  describe("key cap", () => {
    const fill = (n: number, at: (i: number) => number, prefix = "k") => {
      for (let i = 0; i < n; i++) recordLoginFailure(`${prefix}${i}`, at(i));
    };

    it("never tracks more than LOGIN_RATE_MAX_KEYS keys", () => {
      const t0 = 1_000_000;
      fill(LOGIN_RATE_MAX_KEYS, () => t0);
      expect(_loginRateLimitSize()).toBe(LOGIN_RATE_MAX_KEYS);
      recordLoginFailure("newcomer", t0 + 1);
      expect(_loginRateLimitSize()).toBe(LOGIN_RATE_MAX_KEYS);
      fill(50, () => t0 + 2, "more");
      expect(_loginRateLimitSize()).toBe(LOGIN_RATE_MAX_KEYS);
    });

    it("a new key is never refused: it is tracked and can be blocked at the cap", () => {
      const t0 = 1_000_000;
      fill(LOGIN_RATE_MAX_KEYS, () => t0);
      for (let i = 0; i < LOGIN_RATE_MAX; i++) recordLoginFailure("newcomer", t0 + 1 + i);
      expect(_loginRateLimitHas("newcomer")).toBe(true);
      expect(checkLoginBlocked("newcomer", t0 + 100).blocked).toBe(true);
    });

    it("evicts the key with the oldest last failure", () => {
      const t0 = 1_000_000;
      // k0 is the oldest, k(N-1) the newest.
      fill(LOGIN_RATE_MAX_KEYS, (i) => t0 + i);
      recordLoginFailure("newcomer", t0 + LOGIN_RATE_MAX_KEYS);
      expect(_loginRateLimitHas("k0")).toBe(false);
      expect(_loginRateLimitHas("k1")).toBe(true);
      expect(_loginRateLimitHas(`k${LOGIN_RATE_MAX_KEYS - 1}`)).toBe(true);
      expect(_loginRateLimitHas("newcomer")).toBe(true);
    });

    it("the oldest is judged by the last failure, not the first", () => {
      const t0 = 1_000_000;
      fill(LOGIN_RATE_MAX_KEYS, (i) => t0 + i);
      // k0 fails again: it is now the newest, k1 is the oldest.
      recordLoginFailure("k0", t0 + LOGIN_RATE_MAX_KEYS);
      recordLoginFailure("newcomer", t0 + LOGIN_RATE_MAX_KEYS + 1);
      expect(_loginRateLimitHas("k0")).toBe(true);
      expect(_loginRateLimitHas("k1")).toBe(false);
    });

    it("a blocked key newer than the evicted one stays blocked", () => {
      const t0 = 1_000_000;
      fill(LOGIN_RATE_MAX_KEYS - 1, () => t0);
      for (let i = 0; i < LOGIN_RATE_MAX; i++) recordLoginFailure("blocked", t0 + 1000);
      expect(_loginRateLimitSize()).toBe(LOGIN_RATE_MAX_KEYS);
      recordLoginFailure("newcomer", t0 + 2000);
      expect(_loginRateLimitSize()).toBe(LOGIN_RATE_MAX_KEYS);
      expect(checkLoginBlocked("blocked", t0 + 3000).blocked).toBe(true);
    });

    it("an update of a tracked key at the cap evicts nothing", () => {
      const t0 = 1_000_000;
      fill(LOGIN_RATE_MAX_KEYS, (i) => t0 + i);
      recordLoginFailure("k5", t0 + LOGIN_RATE_MAX_KEYS);
      expect(_loginRateLimitSize()).toBe(LOGIN_RATE_MAX_KEYS);
      expect(_loginRateLimitHas("k0")).toBe(true);
    });

    it("prunes expired keys first and keeps live ones instead of evicting", () => {
      const t0 = 1_000_000;
      recordLoginFailure("live", t0 + LOGIN_RATE_WINDOW_MS / 2);
      fill(LOGIN_RATE_MAX_KEYS - 1, () => t0, "old");
      expect(_loginRateLimitSize()).toBe(LOGIN_RATE_MAX_KEYS);
      recordLoginFailure("newcomer", t0 + LOGIN_RATE_WINDOW_MS + 1);
      expect(_loginRateLimitHas("live")).toBe(true);
      expect(_loginRateLimitHas("newcomer")).toBe(true);
      expect(_loginRateLimitSize()).toBe(2);
    });
  });

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

describe("refundLoginFailure", () => {
  beforeEach(() => _resetLoginRateLimit());

  it("removes the newest failure and keeps the window anchored at the oldest", () => {
    const t0 = 1_000_000;
    const t1 = t0 + 60_000;
    recordLoginFailure("k", t0);
    recordLoginFailure("k", t1);
    refundLoginFailure("k");
    expect(_loginFailureCount("k")).toBe(1);
    for (let i = 0; i < LOGIN_RATE_MAX - 1; i++) recordLoginFailure("k", t1);
    // the oldest remaining failure is still t0, not t1
    const r = checkLoginBlocked("k", t1);
    expect(r.blocked).toBe(true);
    expect(r.retryAfterSec).toBe((LOGIN_RATE_WINDOW_MS - 60_000) / 1000);
  });

  it("drops the key when its last failure is refunded", () => {
    recordLoginFailure("k", 1_000_000);
    refundLoginFailure("k");
    expect(_loginRateLimitHas("k")).toBe(false);
  });

  it("is a no-op on an untracked key", () => {
    recordLoginFailure("other", 1_000_000);
    refundLoginFailure("k");
    expect(_loginRateLimitHas("k")).toBe(false);
    expect(_loginFailureCount("other")).toBe(1);
  });
});
