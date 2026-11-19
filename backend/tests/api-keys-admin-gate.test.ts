/**
 * /api/api-keys is admin-only, enforced where app.ts mounts it
 * (requireAuth + requirePanelAuth), through the real createApp.
 *
 * The hole this guards: a native GitHub OAuth `user_session` is
 * `authType "session"` with `isAdmin false`. The gate used to reject only
 * `authType "api_key"`, so such a user could POST a key. The new ApiKey row
 * has no userId, which requireAuth treats as a legacy admin key, so any
 * signed-in user could mint an admin credential, list every tenant's keys and
 * revoke any key.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    apiKey: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    session: { findUnique: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../src/lib/audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/audit.js")>();
  return { ...actual, audit: vi.fn() };
});

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

import { prisma } from "../src/lib/prisma.js";
import { audit } from "../src/lib/audit.js";
import { createApp } from "../src/app.js";

const PANEL = "panel-token-must-be-16chars";

const mApiKey = prisma.apiKey as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};
const mSession = prisma.session as unknown as { findUnique: ReturnType<typeof vi.fn> };

const app = createApp("http://localhost:3000");

type Creds = Record<string, string>;
const panelBearer: Creds = { Authorization: `Bearer ${PANEL}` };
const panelCookie: Creds = { Cookie: `panel_session=${PANEL}` };
const userSession: Creds = { Cookie: "user_session=raw-user-session-token" };
const adminApiKey: Creds = { Authorization: "Bearer dp_legacyadminkey" };
const userApiKey: Creds = { Authorization: "Bearer dp_userboundkey" };

const list = (h: Creds) => app.request("/api/api-keys", { headers: h });
const create = (h: Creds) =>
  app.request("/api/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...h },
    body: JSON.stringify({ name: "ci" }),
  });
const revoke = (h: Creds) => app.request("/api/api-keys/key-1", { method: "DELETE", headers: h });

beforeEach(() => {
  vi.clearAllMocks();
  mApiKey.findMany.mockResolvedValue([]);
  mApiKey.create.mockImplementation(async ({ data }: { data: { name: string; keyHash: string; keyPrefix: string } }) => ({
    id: "new-key",
    name: data.name,
    keyHash: data.keyHash,
    keyPrefix: data.keyPrefix,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  }));
  mApiKey.delete.mockResolvedValue({ id: "key-1", name: "victim", keyPrefix: "dp_abcdefgh" });
  mApiKey.findUnique.mockImplementation(async ({ where }: { where: { keyHash: string } }) => {
    // Resolve by presented key: hashApiKey is deterministic, so match on the
    // two fixtures by recomputing their hashes lazily.
    const { hashApiKey } = await import("../src/middleware/auth.js");
    if (where.keyHash === hashApiKey("dp_legacyadminkey")) {
      return { id: "k-admin", name: "legacy", keyHash: where.keyHash, userId: null, revokedAt: null };
    }
    if (where.keyHash === hashApiKey("dp_userboundkey")) {
      return { id: "k-user", name: "broker", keyHash: where.keyHash, userId: "user-9", revokedAt: null };
    }
    return null;
  });
  // A valid, unexpired non-admin OAuth session.
  mSession.findUnique.mockResolvedValue({ userId: "user-1", expiresAt: new Date(Date.now() + 60_000) });
});

describe("non-admin GitHub OAuth user_session is refused on every api-keys route", () => {
  it("GET: 403 forbidden, keys are not listed", async () => {
    const res = await list(userSession);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("forbidden");
    expect(body.message).toMatch(/admin/i);
    expect(mApiKey.findMany).not.toHaveBeenCalled();
  });

  it("POST: 403 forbidden, no key row is created and nothing is audited", async () => {
    const res = await create(userSession);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("forbidden");
    expect(mApiKey.create).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("DELETE: 403 forbidden, no key is deleted and nothing is audited", async () => {
    const res = await revoke(userSession);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("forbidden");
    expect(mApiKey.delete).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("API key auth stays refused (legacy admin key and user-bound key)", () => {
  it.each([
    ["legacy admin key", adminApiKey],
    ["user-bound key", userApiKey],
  ])("%s: GET, POST and DELETE answer 403 and touch nothing", async (_label, creds) => {
    expect((await list(creds)).status).toBe(403);
    expect((await create(creds)).status).toBe(403);
    expect((await revoke(creds)).status).toBe(403);
    expect(mApiKey.findMany).not.toHaveBeenCalled();
    expect(mApiKey.create).not.toHaveBeenCalled();
    expect(mApiKey.delete).not.toHaveBeenCalled();
  });

  it("the legacy admin key is refused with the panel-authentication message", async () => {
    const body = (await (await list(adminApiKey)).json()) as { message: string };
    expect(body.message).toMatch(/panel authentication/i);
  });
});

describe.each([
  ["panel token (Bearer)", panelBearer, "panel"],
  ["panel_session cookie", panelCookie, "session"],
])("%s is allowed", (_label, creds, expectedActor) => {
  it("GET: 200 with the key list", async () => {
    const res = await list(creds);
    expect(res.status).toBe(200);
    expect(mApiKey.findMany).toHaveBeenCalledOnce();
  });

  it("POST: 201, key stored without userId, audit actor is the real actor with no secret", async () => {
    const res = await create(creds);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: { secret: string } };
    expect(mApiKey.create).toHaveBeenCalledOnce();
    expect(mApiKey.create.mock.calls[0][0].data).not.toHaveProperty("userId");
    expect(audit).toHaveBeenCalledWith("api_key.create", "ci", expect.any(String), expectedActor, null);
    const detail = (audit as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
    expect(detail).not.toContain(body.key.secret);
  });

  it("DELETE: 200, key deleted, audit actor is the real actor", async () => {
    const res = await revoke(creds);
    expect(res.status).toBe(200);
    expect(mApiKey.delete).toHaveBeenCalledWith({ where: { id: "key-1" } });
    expect(audit).toHaveBeenCalledWith("api_key.revoke", "victim", "prefix: dp_abcdefgh", expectedActor, null);
  });
});

describe("unauthenticated", () => {
  it("no credential: 401 on every route", async () => {
    expect((await list({})).status).toBe(401);
    expect((await create({})).status).toBe(401);
    expect((await revoke({})).status).toBe(401);
  });
});
