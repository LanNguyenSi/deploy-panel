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
      // Interactive form: handler(tx) with tx.$executeRaw + tx.apiKey.*
      $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          $executeRaw: vi.fn().mockResolvedValue(0),
          apiKey,
        };
        return fn(tx);
      }),
    },
  };
});

vi.mock("../src/lib/github.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github.js")>(
    "../src/lib/github.js",
  );
  return {
    ...actual,
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
    PORT: 3001,
  },
}));

import { prisma } from "../src/lib/prisma.js";
import {
  fetchGitHubUser,
  GitHubAuthError,
  GitHubUnreachableError,
} from "../src/lib/github.js";
import { authRouter } from "../src/routes/auth.js";

const mockedFetch = vi.mocked(fetchGitHubUser);
const mUser = prisma.user as unknown as { upsert: ReturnType<typeof vi.fn> };
const mApiKey = prisma.apiKey as unknown as {
  updateMany: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};

function call(body: unknown) {
  return authRouter.request("/register-from-project-pilot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /auth/register-from-project-pilot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("400 when githubAccessToken is missing", async () => {
    const res = await call({ githubLogin: "lan" });
    expect(res.status).toBe(400);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("401 when GitHub rejects the token", async () => {
    mockedFetch.mockRejectedValue(new GitHubAuthError("401"));
    const res = await call({ githubAccessToken: "bad" });
    expect(res.status).toBe(401);
    expect(mUser.upsert).not.toHaveBeenCalled();
  });

  it("503 when GitHub is unreachable", async () => {
    mockedFetch.mockRejectedValue(new GitHubUnreachableError("ENOTFOUND"));
    const res = await call({ githubAccessToken: "offline" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("upstream_unavailable");
  });

  it("401 when claimed githubLogin does not match verified identity", async () => {
    mockedFetch.mockResolvedValue({
      id: 7,
      login: "actual",
      name: null,
      avatar_url: "",
      email: null,
    });
    const res = await call({
      githubAccessToken: "valid",
      githubLogin: "pretender",
    });
    expect(res.status).toBe(401);
    expect(mUser.upsert).not.toHaveBeenCalled();
  });

  it("provisions user + rotates a fresh dp_ API key on success", async () => {
    mockedFetch.mockResolvedValue({
      id: 42,
      login: "lan",
      name: "Lan",
      avatar_url: "https://gh/u",
      email: "lan@example.com",
    });
    mUser.upsert.mockResolvedValue({ id: "user-1", githubLogin: "lan" });
    mApiKey.updateMany.mockResolvedValue({ count: 0 });

    const res = await call({ githubAccessToken: "valid", githubLogin: "lan" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      apiToken: string;
      userId: string;
      githubLogin: string;
    };
    expect(body.userId).toBe("user-1");
    expect(body.githubLogin).toBe("lan");
    expect(body.apiToken).toMatch(/^dp_/);

    // Rotation: any prior unrevoked project-pilot key for this user must be
    // swept into revokedAt, then a new one minted.
    expect(mApiKey.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", name: "project-pilot", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      }),
    );
    expect(mApiKey.create).toHaveBeenCalledTimes(1);
  });

  it("never leaks the GitHub access-token in any response body", async () => {
    mockedFetch.mockRejectedValue(new GitHubAuthError("401"));
    const res = await call({ githubAccessToken: "super-secret-xyz" });
    const text = await res.text();
    expect(text).not.toContain("super-secret-xyz");
  });
});
