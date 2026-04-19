import { describe, expect, it, vi, beforeEach } from "vitest";

const { allowedLoginsMock } = vi.hoisted(() => ({
  allowedLoginsMock: [] as string[],
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    user: { upsert: vi.fn() },
    session: { create: vi.fn().mockResolvedValue({}) },
    apiKey: { updateMany: vi.fn(), create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        $executeRaw: vi.fn().mockResolvedValue(0),
        apiKey: { updateMany: vi.fn(), create: vi.fn().mockResolvedValue({}) },
      };
      return fn(tx);
    }),
  },
}));

vi.mock("../src/lib/github.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github.js")>(
    "../src/lib/github.js",
  );
  return {
    ...actual,
    exchangeCodeForToken: vi.fn(),
    fetchGitHubUser: vi.fn(),
  };
});

vi.mock("../src/config/index.js", () => ({
  config: {
    NODE_ENV: "test",
    PANEL_TOKEN: "panel-token-must-be-16chars",
    SESSION_SECRET: "session-secret-must-be-16chars",
    CORS_ORIGINS: "http://localhost:3000",
    FRONTEND_URL: "http://localhost:3000",
    BACKEND_URL: "http://localhost:3001",
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CLIENT_SECRET: "test-client-secret",
    PORT: 3001,
    ALLOWED_GITHUB_LOGINS: "",
  },
  allowedGitHubLogins: allowedLoginsMock,
  hasGitHubOAuthConfigured: true,
}));

import { prisma } from "../src/lib/prisma.js";
import {
  exchangeCodeForToken,
  fetchGitHubUser,
  GitHubAuthError,
  GitHubUnreachableError,
} from "../src/lib/github.js";
import { authRouter } from "../src/routes/auth.js";

const mExchange = vi.mocked(exchangeCodeForToken);
const mFetchUser = vi.mocked(fetchGitHubUser);
const mUser = prisma.user as unknown as { upsert: ReturnType<typeof vi.fn> };
const mSession = prisma.session as unknown as {
  create: ReturnType<typeof vi.fn>;
};

describe("GET /auth/github/config", () => {
  it("reports configured: true when client id + secret are set", async () => {
    const res = await authRouter.request("/github/config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { configured: boolean };
    expect(body.configured).toBe(true);
  });
});

describe("GET /auth/github/start", () => {
  it("302s to github authorize with a state cookie", async () => {
    const res = await authRouter.request("/github/start");
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    expect(location).toContain("client_id=test-client-id");
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toMatch(/^dp_oauth_state=/);
  });
});

describe("GET /auth/github/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allowedLoginsMock.length = 0;
  });

  it("redirects to login with state_mismatch when no state cookie present", async () => {
    const res = await authRouter.request("/github/callback?code=abc&state=xyz");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=state_mismatch");
    expect(mExchange).not.toHaveBeenCalled();
  });

  it("redirects to login with state_mismatch when state diverges", async () => {
    const res = await authRouter.request("/github/callback?code=abc&state=xyz", {
      headers: { Cookie: "dp_oauth_state=other" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=state_mismatch");
    expect(mExchange).not.toHaveBeenCalled();
  });

  it("redirects with missing_code when code param is absent", async () => {
    const res = await authRouter.request("/github/callback?state=xyz", {
      headers: { Cookie: "dp_oauth_state=xyz" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=missing_code");
  });

  it("redirects with oauth_failed when GitHub rejects the code", async () => {
    mExchange.mockRejectedValue(new GitHubAuthError("401"));
    const res = await authRouter.request("/github/callback?code=bad&state=xyz", {
      headers: { Cookie: "dp_oauth_state=xyz" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=oauth_failed");
  });

  it("redirects with upstream_unavailable when GitHub is unreachable", async () => {
    mExchange.mockRejectedValue(new GitHubUnreachableError("ENOTFOUND"));
    const res = await authRouter.request("/github/callback?code=ok&state=xyz", {
      headers: { Cookie: "dp_oauth_state=xyz" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=upstream_unavailable");
  });

  it("redirects with forbidden_github_login when the login is not in ALLOWED list", async () => {
    allowedLoginsMock.push("authorized-user");
    mExchange.mockResolvedValue({
      access_token: "gh-tok",
      token_type: "bearer",
      scope: "read:user",
    });
    mFetchUser.mockResolvedValue({
      id: 42,
      login: "stranger",
      name: null,
      avatar_url: "",
      email: null,
    });

    const res = await authRouter.request("/github/callback?code=ok&state=xyz", {
      headers: { Cookie: "dp_oauth_state=xyz" },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=forbidden_github_login");
    expect(mUser.upsert).not.toHaveBeenCalled();
  });

  it("upserts user + creates session + redirects to frontend on success", async () => {
    mExchange.mockResolvedValue({
      access_token: "gh-tok",
      token_type: "bearer",
      scope: "read:user",
    });
    mFetchUser.mockResolvedValue({
      id: 99,
      login: "lan",
      name: "Lan",
      avatar_url: "https://gh/u",
      email: "lan@example.com",
    });
    mUser.upsert.mockResolvedValue({ id: "user-1", githubLogin: "lan" });

    const res = await authRouter.request("/github/callback?code=ok&state=xyz", {
      headers: { Cookie: "dp_oauth_state=xyz" },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("http://localhost:3000");

    // Set-Cookie headers: state cookie cleared + user_session set.
    const setCookies =
      res.headers.getSetCookie?.() ?? [res.headers.get("Set-Cookie") ?? ""];
    const userSession = setCookies.find((c) => c.startsWith("user_session="));
    expect(userSession).toBeDefined();
    expect(userSession).toMatch(/SameSite=Lax/i);
    expect(userSession).toMatch(/HttpOnly/i);

    expect(mSession.create).toHaveBeenCalledTimes(1);
    expect(mUser.upsert).toHaveBeenCalledTimes(1);
  });

  it("never leaks the access-token in redirect URLs or Set-Cookie headers", async () => {
    mExchange.mockResolvedValue({
      access_token: "super-secret-gh-tok-xyz",
      token_type: "bearer",
      scope: "read:user",
    });
    mFetchUser.mockResolvedValue({
      id: 1,
      login: "lan",
      name: null,
      avatar_url: "",
      email: null,
    });
    mUser.upsert.mockResolvedValue({ id: "user-1" });

    const res = await authRouter.request("/github/callback?code=ok&state=xyz", {
      headers: { Cookie: "dp_oauth_state=xyz" },
    });

    const location = res.headers.get("Location") ?? "";
    const setCookie = (
      res.headers.getSetCookie?.() ?? [res.headers.get("Set-Cookie") ?? ""]
    ).join("\n");

    expect(location).not.toContain("super-secret-gh-tok-xyz");
    expect(setCookie).not.toContain("super-secret-gh-tok-xyz");
  });
});
