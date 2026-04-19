import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    deploy: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
    },
    app: {
      findMany: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
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
import { deploysRouter } from "../src/routes/deploys.js";
import { auditRouter } from "../src/routes/audit.js";
import { Hono } from "hono";

const mServer = prisma.server as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};
const mDeploy = prisma.deploy as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
};

type ActorVars = {
  Variables: { userId?: string; isAdmin?: boolean; authType?: string };
};

// Spin up a minimal app with a stub "requireAuth" that sets the actor
// directly. This mirrors what the real middleware does without dragging in
// database-backed api-key lookups.
function appFor(actor: { userId: string | null; isAdmin: boolean }) {
  const app = new Hono<ActorVars>();
  // Inject actor on every path via wildcard + all HTTP verbs. Hono's
  // `app.use("*")` isn't reliable across sub-routers' root path matches,
  // but mounting the middleware inline before each route() works.
  app.use("/*", async (c, next) => {
    if (actor.userId) c.set("userId", actor.userId);
    c.set("isAdmin", actor.isAdmin);
    await next();
  });
  app.route("/servers", serversRouter as unknown as Hono<ActorVars>);
  app.route("/deploys", deploysRouter as unknown as Hono<ActorVars>);
  app.route("/audit", auditRouter as unknown as Hono<ActorVars>);
  return app;
}

describe("deploy-panel per-user isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("admin sees every server (no where.userId filter)", async () => {
    mServer.findMany.mockResolvedValue([]);
    await appFor({ userId: null, isAdmin: true }).request("/servers");
    const where = mServer.findMany.mock.calls[0]?.[0]?.where ?? {};
    expect(where.userId).toBeUndefined();
  });

  it("non-admin server list carries where.userId = actor.userId", async () => {
    mServer.findMany.mockResolvedValue([]);
    await appFor({ userId: "user-a", isAdmin: false }).request("/servers");
    const where = mServer.findMany.mock.calls[0]?.[0]?.where;
    expect(where?.userId).toBe("user-a");
  });

  it("non-admin GET /servers/:id returns 404 for a server owned by another user", async () => {
    mServer.findUnique.mockResolvedValue({
      id: "srv-b",
      userId: "user-b",
      name: "b",
      host: "b.example",
      status: "online",
      relayUrl: null,
      relayToken: null,
      sshKeyPath: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/srv-b",
    );
    expect(res.status).toBe(404);
  });

  it("non-admin can GET their own server", async () => {
    // findOwnedServer issues one findUnique; the route then issues a second
    // with the include payload.
    mServer.findUnique.mockResolvedValue({
      id: "srv-a",
      userId: "user-a",
      name: "a",
      host: "a.example",
      status: "online",
      relayUrl: null,
      relayToken: null,
      sshKeyPath: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/srv-a",
    );
    expect(res.status).toBe(200);
  });

  it("non-admin POST /servers stamps actor.userId on create", async () => {
    mServer.findUnique.mockResolvedValue(null);
    mServer.create.mockResolvedValue({
      id: "srv-new",
      userId: "user-a",
      name: "n",
      host: "n.example",
      status: "unknown",
      relayUrl: null,
      relayToken: null,
      sshKeyPath: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "n", host: "n.example" }),
      },
    );

    expect(res.status).toBe(201);
    const createArg = mServer.create.mock.calls[0]?.[0];
    expect(createArg?.data?.userId).toBe("user-a");
  });

  it("non-admin PATCH /servers/:id refuses to mutate another user's server", async () => {
    mServer.findUnique.mockResolvedValue({
      id: "srv-b",
      userId: "user-b",
      name: "b",
      host: "b.example",
      status: "online",
      relayUrl: null,
      relayToken: null,
      sshKeyPath: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/srv-b",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "hijacked" }),
      },
    );

    expect(res.status).toBe(404);
    expect(mServer.update).not.toHaveBeenCalled();
  });

  it("non-admin deploy list inherits ownership filter via server relation", async () => {
    mDeploy.findMany.mockResolvedValue([]);
    mDeploy.count.mockResolvedValue(0);

    await appFor({ userId: "user-a", isAdmin: false }).request("/deploys");

    const where = mDeploy.findMany.mock.calls[0]?.[0]?.where;
    expect(where?.server).toEqual({ userId: "user-a" });
  });

  it("non-admin GET /deploys/:id returns 404 when parent server is foreign", async () => {
    mDeploy.findUnique.mockResolvedValue({
      id: "d1",
      status: "success",
      serverId: "srv-b",
      appId: "app-b",
      commitBefore: null,
      commitAfter: null,
      duration: null,
      log: null,
      triggeredBy: "panel",
      createdAt: new Date(),
      app: { name: "b", repoUrl: null, branch: "main" },
      server: { name: "b", host: "b.example", userId: "user-b" },
    });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/deploys/d1",
    );
    expect(res.status).toBe(404);
  });

  it("admin POST /servers creates with userId=null (admin-shared)", async () => {
    mServer.findUnique.mockResolvedValue(null);
    mServer.create.mockResolvedValue({
      id: "srv-admin",
      userId: null,
      name: "admin-host",
      host: "admin.example",
      status: "unknown",
      relayUrl: null,
      relayToken: null,
      sshKeyPath: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "admin-host", host: "admin.example" }),
      },
    );

    expect(res.status).toBe(201);
    const createArg = mServer.create.mock.calls[0]?.[0];
    // Strict null: must NOT be undefined (Prisma would drop it silently if
    // so, leaving the column empty which is technically the same but
    // semantically muddier).
    expect(createArg?.data?.userId).toBeNull();
  });

  it("/api/audit is admin-only (non-admin gets an empty result)", async () => {
    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/audit",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[]; total: number };
    expect(body.entries).toEqual([]);
    expect(body.total).toBe(0);
  });
});
