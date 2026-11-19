import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

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
    BACKEND_URL: "http://localhost:3001",
    GITHUB_CLIENT_ID: "",
    GITHUB_CLIENT_SECRET: "",
    PORT: 3001,
    ALLOWED_GITHUB_LOGINS: "",
  },
  allowedGitHubLogins: [],
  hasGitHubOAuthConfigured: false,
}));

import { prisma } from "../src/lib/prisma.js";
import { authRouter } from "../src/routes/auth.js";
import { hashSessionToken, validateSession } from "../src/lib/session.js";

const mSession = prisma.session as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
};

const RAW = "a".repeat(64);

function logout(cookie?: string): Promise<Response> {
  return authRouter.request("/logout", {
    method: "POST",
    headers: cookie === undefined ? {} : { Cookie: cookie },
  });
}

function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}

function expectBothCookiesCleared(res: Response): void {
  const cookies = setCookies(res);
  expect(cookies.some((c) => c.startsWith("panel_session=;") && c.includes("Max-Age=0"))).toBe(true);
  expect(cookies.some((c) => c.startsWith("user_session=;") && c.includes("Max-Age=0"))).toBe(true);
}

describe("POST /auth/logout revokes the user session", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mSession.deleteMany.mockResolvedValue({ count: 1 });
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("deletes the sessions row of the presented user_session cookie and clears both cookies", async () => {
    const res = await logout(`user_session=${RAW}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mSession.deleteMany).toHaveBeenCalledTimes(1);
    expect(mSession.deleteMany).toHaveBeenCalledWith({
      where: { tokenHash: hashSessionToken(RAW) },
    });
    expectBothCookiesCleared(res);
  });

  it("finds the user_session cookie among other cookies", async () => {
    const res = await logout(`panel_session=x; user_session=${RAW}; theme=dark`);
    expect(res.status).toBe(200);
    expect(mSession.deleteMany).toHaveBeenCalledWith({
      where: { tokenHash: hashSessionToken(RAW) },
    });
  });

  it("does not take a cookie whose name merely ends in user_session", async () => {
    const res = await logout(`xuser_session=${RAW}`);
    expect(res.status).toBe(200);
    expect(mSession.deleteMany).not.toHaveBeenCalled();
    expectBothCookiesCleared(res);
  });

  it("answers 200 and clears the cookies when there is no Cookie header", async () => {
    const res = await logout();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mSession.deleteMany).not.toHaveBeenCalled();
    expectBothCookiesCleared(res);
  });

  it("answers 200 and clears the cookies when only panel_session is present", async () => {
    const res = await logout("panel_session=panel-token-must-be-16chars");
    expect(res.status).toBe(200);
    expect(mSession.deleteMany).not.toHaveBeenCalled();
    expectBothCookiesCleared(res);
  });

  it("answers 200 and clears the cookies when the cookie value is malformed (URIError)", async () => {
    const res = await logout("user_session=%E0%A4%A");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mSession.deleteMany).not.toHaveBeenCalled();
    expectBothCookiesCleared(res);
  });

  it("answers 200 when the row is already gone (deleteMany count 0)", async () => {
    mSession.deleteMany.mockResolvedValue({ count: 0 });
    const res = await logout(`user_session=${RAW}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expectBothCookiesCleared(res);
  });

  it("logs a DB error and still answers 200 with both cookies cleared", async () => {
    mSession.deleteMany.mockRejectedValue(new Error("db down"));
    const res = await logout(`user_session=${RAW}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expectBothCookiesCleared(res);
    expect(errorSpy).toHaveBeenCalled();
    // The raw token must not reach the log.
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(RAW);
  });

  it("makes validateSession return null for the old raw token once the row is deleted", async () => {
    // In-memory stand-in for the sessions table keyed by token hash.
    const rows = new Map<string, { userId: string; expiresAt: Date }>();
    rows.set(hashSessionToken(RAW), {
      userId: "user-1",
      expiresAt: new Date(Date.now() + 60_000),
    });
    mSession.findUnique.mockImplementation(
      async ({ where }: { where: { tokenHash: string } }) => rows.get(where.tokenHash) ?? null,
    );
    mSession.deleteMany.mockImplementation(
      async ({ where }: { where: { tokenHash: string } }) => {
        const existed = rows.delete(where.tokenHash);
        return { count: existed ? 1 : 0 };
      },
    );

    expect(await validateSession(RAW)).toBe("user-1");
    const res = await logout(`user_session=${RAW}`);
    expect(res.status).toBe(200);
    expect(mSession.deleteMany).toHaveBeenCalledWith({
      where: { tokenHash: hashSessionToken(RAW) },
    });
    expect(await validateSession(RAW)).toBeNull();
  });
});
