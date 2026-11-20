import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { allowedLoginsMock, configMock } = vi.hoisted(() => ({
  allowedLoginsMock: [] as string[],
  configMock: {
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
  } as Record<string, unknown>,
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
  config: configMock,
  allowedGitHubLogins: allowedLoginsMock,
  // Getter so a test can disable OAuth (empty client id/secret) to reach the
  // not_configured redirect; reads the same mutable object the routes see.
  get hasGitHubOAuthConfigured() {
    return (
      (configMock.GITHUB_CLIENT_ID as string).length > 0 &&
      (configMock.GITHUB_CLIENT_SECRET as string).length > 0
    );
  },
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

describe("GET /auth/github/start with a trailing slash in BACKEND_URL", () => {
  afterEach(() => {
    configMock.BACKEND_URL = "http://localhost:3001";
  });

  it("sends GitHub a redirect_uri with a single slash", async () => {
    configMock.BACKEND_URL = "https://panel.example.com//";
    const res = await authRouter.request("/github/start");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://panel.example.com/api/auth/github/callback",
    );
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

  describe("state cookie is read by exact name", () => {
    it("ignores a cookie whose name merely ends in dp_oauth_state (state matches the real cookie)", async () => {
      mExchange.mockRejectedValue(new GitHubAuthError("401"));
      const res = await authRouter.request("/github/callback?code=abc&state=good", {
        headers: { Cookie: "xdp_oauth_state=evil; dp_oauth_state=good" },
      });
      expect(res.status).toBe(302);
      // Past the state check: the code exchange ran and failed.
      expect(mExchange).toHaveBeenCalledTimes(1);
      expect(res.headers.get("Location")).toContain("error=oauth_failed");
    });

    it("rejects the value of the prefixed cookie when the real cookie differs", async () => {
      const res = await authRouter.request("/github/callback?code=abc&state=evil", {
        headers: { Cookie: "xdp_oauth_state=evil; dp_oauth_state=good" },
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain("error=state_mismatch");
      expect(mExchange).not.toHaveBeenCalled();
    });

    it("rejects a request that only carries the prefixed cookie", async () => {
      const res = await authRouter.request("/github/callback?code=abc&state=evil", {
        headers: { Cookie: "xdp_oauth_state=evil" },
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain("error=state_mismatch");
      expect(mExchange).not.toHaveBeenCalled();
    });

    it.each(["x-dp_oauth_state", "__Host-dp_oauth_state", "x.dp_oauth_state"])(
      "a cookie named %s does not supply the state",
      async (name) => {
        const res = await authRouter.request("/github/callback?code=abc&state=evil", {
          headers: { Cookie: `${name}=evil` },
        });
        expect(res.status).toBe(302);
        expect(res.headers.get("Location")).toContain("error=state_mismatch");
        expect(mExchange).not.toHaveBeenCalled();
      },
    );

    it("still reads the cookie when it is the first of several", async () => {
      mExchange.mockRejectedValue(new GitHubAuthError("401"));
      const res = await authRouter.request("/github/callback?code=abc&state=good", {
        headers: { Cookie: "dp_oauth_state=good; other=1" },
      });
      expect(res.headers.get("Location")).toContain("error=oauth_failed");
    });
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

  it("accepts when GitHub's login differs from the allowlist entry only in case", async () => {
    // GitHub logins are case-insensitive: the helper must see the mocked
    // list (same reference as the config mock) and compare normalised.
    allowedLoginsMock.push("Authorized-User");
    mExchange.mockResolvedValue({
      access_token: "gh-tok",
      token_type: "bearer",
      scope: "read:user",
    });
    mFetchUser.mockResolvedValue({
      id: 42,
      login: "authorized-user",
      name: null,
      avatar_url: "",
      email: null,
    });
    mUser.upsert.mockResolvedValue({ id: "user-1", githubLogin: "authorized-user" });

    const res = await authRouter.request("/github/callback?code=ok&state=xyz", {
      headers: { Cookie: "dp_oauth_state=xyz" },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("http://localhost:3000");
    expect(mUser.upsert).toHaveBeenCalledTimes(1);
  });

  it("accepts the reverse casing: lowercase entry, GitHub login in mixed case", async () => {
    allowedLoginsMock.push("authorized-user");
    mExchange.mockResolvedValue({
      access_token: "gh-tok",
      token_type: "bearer",
      scope: "read:user",
    });
    mFetchUser.mockResolvedValue({
      id: 42,
      login: "Authorized-User",
      name: null,
      avatar_url: "",
      email: null,
    });
    mUser.upsert.mockResolvedValue({ id: "user-1", githubLogin: "Authorized-User" });

    const res = await authRouter.request("/github/callback?code=ok&state=xyz", {
      headers: { Cookie: "dp_oauth_state=xyz" },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("http://localhost:3000");
    expect(mUser.upsert).toHaveBeenCalledTimes(1);
    // Stored login keeps GitHub's casing.
    expect(mUser.upsert.mock.calls[0][0].create.githubLogin).toBe("Authorized-User");
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

// A FRONTEND_URL configured with a trailing slash (PANEL_PUBLIC_ORIGIN typed
// as "https://panel.example.com/") used to concatenate into doubled-slash
// redirects ("https://panel.example.com//login?error=..."). Every redirect
// site in routes/auth.ts trims the trailing slashes before use (the config
// value itself stays verbatim), so each Location is exactly <origin>/login?
// error=... with a single slash, and the success redirect lands on the
// origin without a trailing slash.
describe("GET /auth/github/callback with a trailing slash in FRONTEND_URL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allowedLoginsMock.length = 0;
    configMock.FRONTEND_URL = "https://panel.example.com/";
  });

  afterEach(() => {
    configMock.FRONTEND_URL = "http://localhost:3000";
    configMock.GITHUB_CLIENT_ID = "test-client-id";
    configMock.GITHUB_CLIENT_SECRET = "test-client-secret";
  });

  it("not_configured error redirect has a single slash", async () => {
    configMock.GITHUB_CLIENT_ID = "";
    configMock.GITHUB_CLIENT_SECRET = "";
    const res = await authRouter.request("/github/callback?code=abc&state=xyz");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://panel.example.com/login?error=not_configured",
    );
  });

  it("missing_code error redirect has a single slash", async () => {
    const res = await authRouter.request("/github/callback?state=xyz", {
      headers: { Cookie: "dp_oauth_state=xyz" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://panel.example.com/login?error=missing_code",
    );
  });

  it("state_mismatch error redirect has a single slash", async () => {
    const res = await authRouter.request("/github/callback?code=abc&state=xyz", {
      headers: { Cookie: "dp_oauth_state=other" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://panel.example.com/login?error=state_mismatch",
    );
  });

  it("oauth_failed error redirect has a single slash", async () => {
    mExchange.mockRejectedValue(new GitHubAuthError("401"));
    const res = await authRouter.request("/github/callback?code=bad&state=xyz", {
      headers: { Cookie: "dp_oauth_state=xyz" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://panel.example.com/login?error=oauth_failed",
    );
  });

  it("upstream_unavailable error redirect has a single slash", async () => {
    mExchange.mockRejectedValue(new GitHubUnreachableError("ENOTFOUND"));
    const res = await authRouter.request("/github/callback?code=ok&state=xyz", {
      headers: { Cookie: "dp_oauth_state=xyz" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://panel.example.com/login?error=upstream_unavailable",
    );
  });

  it("forbidden_github_login error redirect has a single slash", async () => {
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
    expect(res.headers.get("Location")).toBe(
      "https://panel.example.com/login?error=forbidden_github_login",
    );
  });

  it("success redirect lands on the origin without a trailing slash", async () => {
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
    expect(res.headers.get("Location")).toBe("https://panel.example.com");
  });

  it('an empty FRONTEND_URL keeps today\'s success redirect: 302 with an empty Location', async () => {
    configMock.FRONTEND_URL = "";
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

    // Documented behaviour: FRONTEND_URL defaults to "" in the schema, and
    // trimming "" yields "", so the 302 keeps the empty Location it always had.
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("");
  });
});
