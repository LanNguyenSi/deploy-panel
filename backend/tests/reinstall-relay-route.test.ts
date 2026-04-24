import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
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
  allowedGitHubLogins: [],
}));

import { prisma } from "../src/lib/prisma.js";
import { serversRouter } from "../src/routes/servers.js";
import { Hono } from "hono";

type ActorVars = {
  Variables: { userId?: string; isAdmin?: boolean; authType?: string };
};

const mServer = prisma.server as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

function appFor(actor: { userId: string | null; isAdmin: boolean }) {
  const app = new Hono<ActorVars>();
  app.use("/*", async (c, next) => {
    if (actor.userId) c.set("userId", actor.userId);
    c.set("isAdmin", actor.isAdmin);
    await next();
  });
  app.route("/servers", serversRouter as unknown as Hono<ActorVars>);
  return app;
}

const validBody = {
  sshUser: "root",
  sshPort: 22,
  sshPassword: "hunter2",
};

const asJson = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("POST /servers/:id/install-relay (re-install)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when server does not exist", async () => {
    mServer.findUnique.mockResolvedValue(null);
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-missing/install-relay",
      asJson(validBody),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 (not 403) when a non-admin tries to re-install someone else's server", async () => {
    // findOwnedServer returns null for ownership mismatch — same response
    // shape as not-found, so we assert the same status code. (Don't leak
    // existence of the row to a non-owner.)
    mServer.findUnique.mockResolvedValue({
      id: "srv-b",
      userId: "user-b",
      name: "b",
      host: "b.example",
      relayUrl: null,
      relayToken: null,
      hostKeySha256: null,
      relayMode: null,
      status: "online",
      sshKeyPath: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/srv-b/install-relay",
      asJson(validBody),
    );
    expect(res.status).toBe(404);
  });

  it("rejects non-JSON body with 400", async () => {
    mServer.findUnique.mockResolvedValue({
      id: "srv-a",
      userId: null,
      name: "a",
      host: "a.example",
      relayUrl: "http://a:8222",
      relayToken: "tok",
      hostKeySha256: "fp==",
      relayMode: "greenfield",
      status: "online",
      sshKeyPath: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/install-relay",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      },
    );
    expect(res.status).toBe(400);
  });

  it("rejects missing credentials with 400", async () => {
    mServer.findUnique.mockResolvedValue({
      id: "srv-a",
      userId: null,
      name: "a",
      host: "a.example",
      relayUrl: "http://a:8222",
      relayToken: "tok",
      hostKeySha256: null,
      relayMode: null,
      status: "online",
      sshKeyPath: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { sshPassword: _pw, ...bodyNoAuth } = validBody;
    void _pw;
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/install-relay",
      asJson(bodyNoAuth),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an invalid relayMode enum value with 400", async () => {
    mServer.findUnique.mockResolvedValue({
      id: "srv-a",
      userId: null,
      name: "a",
      host: "a.example",
      relayUrl: null,
      relayToken: null,
      hostKeySha256: null,
      relayMode: null,
      status: "online",
      sshKeyPath: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/install-relay",
      asJson({ ...validBody, relayMode: "bogus-mode" }),
    );
    expect(res.status).toBe(400);
  });

  it("admin can re-install any server (passes ownership gate)", async () => {
    // Even a server owned by user-b is re-installable by an admin.
    mServer.findUnique.mockResolvedValue({
      id: "srv-b",
      userId: "user-b",
      name: "b",
      host: "b.example",
      relayUrl: null,
      relayToken: null,
      hostKeySha256: null,
      relayMode: null,
      status: "online",
      sshKeyPath: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-b/install-relay",
      asJson(validBody),
    );
    // Schema-valid request → route enters streamSSE — we don't drive the
    // SSH layer here (separate integration test would). What we assert:
    // the route did NOT bounce on auth/validation, so the status is 200
    // (SSE response always starts with 200).
    expect(res.status).toBe(200);
  });

  it("server-owner (non-admin) can re-install their own server", async () => {
    mServer.findUnique.mockResolvedValue({
      id: "srv-a",
      userId: "user-a",
      name: "a",
      host: "a.example",
      relayUrl: null,
      relayToken: null,
      hostKeySha256: null,
      relayMode: null,
      status: "online",
      sshKeyPath: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/srv-a/install-relay",
      asJson(validBody),
    );
    expect(res.status).toBe(200);
  });
});
