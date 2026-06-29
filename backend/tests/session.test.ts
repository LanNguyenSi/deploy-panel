import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    session: {
      create: vi.fn(),
      findUnique: vi.fn(),
      deleteMany: vi.fn(),
    },
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
  },
}));

import { prisma } from "../src/lib/prisma.js";
import {
  generateSessionToken,
  hashSessionToken,
  createSession,
  validateSession,
  deleteSession,
  buildUserSessionCookie,
  buildClearUserSessionCookie,
  readUserSessionCookie,
} from "../src/lib/session.js";

const mSession = prisma.session as unknown as {
  create: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
};

// ── Pure functions ────────────────────────────────────────────────────────────

describe("hashSessionToken — deterministic SHA-256", () => {
  it("returns a 64-char lowercase hex string", () => {
    const hash = hashSessionToken("some-token");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("same input always produces the same hash", () => {
    const token = "stable-input";
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });

  it("different inputs produce different hashes", () => {
    expect(hashSessionToken("token-a")).not.toBe(hashSessionToken("token-b"));
  });
});

describe("generateSessionToken — random 64-hex token", () => {
  it("returns a 64-char lowercase hex string", () => {
    const tok = generateSessionToken();
    expect(tok).toMatch(/^[0-9a-f]{64}$/);
  });

  it("successive calls produce unique tokens", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
  });
});

describe("buildUserSessionCookie — Set-Cookie header value", () => {
  it("includes HttpOnly, SameSite=Lax, Max-Age=2592000, Path=/ for a 30-day session", () => {
    const cookie = buildUserSessionCookie("tok123", true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=2592000");
    expect(cookie).toContain("Path=/");
  });

  it("includes Secure when secure=true", () => {
    const cookie = buildUserSessionCookie("tok123", true);
    expect(cookie).toContain("Secure");
  });

  it("omits Secure when secure=false", () => {
    const cookie = buildUserSessionCookie("tok123", false);
    expect(cookie).not.toContain("Secure");
  });

  it("encodes the token in the cookie value", () => {
    const token = "abc123";
    const cookie = buildUserSessionCookie(token, false);
    expect(cookie).toContain(`user_session=${encodeURIComponent(token)}`);
  });
});

describe("buildClearUserSessionCookie", () => {
  it("sets Max-Age=0 to expire the cookie immediately", () => {
    const cookie = buildClearUserSessionCookie();
    expect(cookie).toContain("Max-Age=0");
  });

  it("includes the cookie name so the browser overwrites the existing one", () => {
    const cookie = buildClearUserSessionCookie();
    expect(cookie).toContain("user_session=");
  });
});

describe("readUserSessionCookie", () => {
  it("extracts the token from a Cookie header", () => {
    const token = readUserSessionCookie("user_session=mytoken123");
    expect(token).toBe("mytoken123");
  });

  it("extracts the token when other cookies are present", () => {
    const token = readUserSessionCookie("other=foo; user_session=mytoken456; bar=baz");
    expect(token).toBe("mytoken456");
  });

  it("returns null when the cookie is absent", () => {
    expect(readUserSessionCookie("other=cookie")).toBeNull();
  });

  it("returns null when the header is undefined", () => {
    expect(readUserSessionCookie(undefined)).toBeNull();
  });

  it("returns null when the header is null", () => {
    expect(readUserSessionCookie(null)).toBeNull();
  });
});

// ── validateSession ───────────────────────────────────────────────────────────

describe("validateSession — auth-critical session lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the userId for a valid unexpired session", async () => {
    const rawToken = generateSessionToken();
    mSession.findUnique.mockResolvedValue({
      id: "sess-1",
      tokenHash: hashSessionToken(rawToken),
      userId: "user-a",
      expiresAt: new Date(Date.now() + 86400_000), // expires tomorrow
      createdAt: new Date(),
    });

    const userId = await validateSession(rawToken);
    expect(userId).toBe("user-a");
  });

  it("looks up by the HASHED token, never the raw token", async () => {
    const rawToken = "raw-plaintext-token";
    mSession.findUnique.mockResolvedValue(null);

    await validateSession(rawToken);

    expect(mSession.findUnique).toHaveBeenCalledOnce();
    const lookupArg = mSession.findUnique.mock.calls[0][0];
    expect(lookupArg.where.tokenHash).toBe(hashSessionToken(rawToken));
    // Raw token must never appear in the DB lookup
    expect(lookupArg.where.tokenHash).not.toBe(rawToken);
  });

  it("returns null when no session row exists", async () => {
    mSession.findUnique.mockResolvedValue(null);
    const result = await validateSession("nonexistent-token");
    expect(result).toBeNull();
  });

  it("returns null for an EXPIRED session (auth-critical expiry branch)", async () => {
    const rawToken = generateSessionToken();
    mSession.findUnique.mockResolvedValue({
      id: "sess-expired",
      tokenHash: hashSessionToken(rawToken),
      userId: "user-a",
      // expiresAt is in the past — this is the branch that must be asserted
      expiresAt: new Date(Date.now() - 1000),
      createdAt: new Date(),
    });

    const result = await validateSession(rawToken);
    expect(result).toBeNull();
  });

  it("returns null for an empty string token (fast-path guard)", async () => {
    const result = await validateSession("");
    expect(result).toBeNull();
    // Should not even attempt a DB lookup for empty tokens
    expect(mSession.findUnique).not.toHaveBeenCalled();
  });
});

// ── createSession ─────────────────────────────────────────────────────────────

describe("createSession — session creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores the HASH of the token, not the raw token", async () => {
    mSession.create.mockResolvedValue({});

    const { token } = await createSession("user-a");

    expect(mSession.create).toHaveBeenCalledOnce();
    const createData = mSession.create.mock.calls[0][0].data;
    // tokenHash must match the sha256 of the returned raw token
    expect(createData.tokenHash).toBe(hashSessionToken(token));
    // Raw token must NOT be stored directly
    expect(createData.tokenHash).not.toBe(token);
  });

  it("sets a ~30-day expiry (2592000 seconds)", async () => {
    mSession.create.mockResolvedValue({});

    const before = Date.now();
    const { expiresAt } = await createSession("user-a");
    const after = Date.now();

    const expectedMs = 30 * 24 * 60 * 60 * 1000;
    const delta = expiresAt.getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(expectedMs - 1000);
    expect(delta).toBeLessThanOrEqual(expectedMs + (after - before) + 1000);
  });

  it("returns the raw (unhashed) token for the caller to set in the cookie", async () => {
    mSession.create.mockResolvedValue({});

    const { token } = await createSession("user-a");
    // Token must be 64-char hex (32 random bytes)
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    // The stored hash must differ from the returned token
    const storedHash = mSession.create.mock.calls[0][0].data.tokenHash;
    expect(storedHash).not.toBe(token);
  });
});

// ── deleteSession ─────────────────────────────────────────────────────────────

describe("deleteSession — session revocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes by the hashed token", async () => {
    mSession.deleteMany.mockResolvedValue({ count: 1 });

    const rawToken = "token-to-delete";
    await deleteSession(rawToken);

    expect(mSession.deleteMany).toHaveBeenCalledOnce();
    const deleteArg = mSession.deleteMany.mock.calls[0][0];
    expect(deleteArg.where.tokenHash).toBe(hashSessionToken(rawToken));
  });

  it("no-ops silently for an empty token", async () => {
    await deleteSession("");
    expect(mSession.deleteMany).not.toHaveBeenCalled();
  });
});
