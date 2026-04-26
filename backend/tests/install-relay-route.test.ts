import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

// Default dns.lookup result so non-admin host check resolves to a
// public address; individual tests can override.
vi.mock("node:dns", () => ({
  promises: {
    lookup: vi.fn().mockResolvedValue([{ address: "203.0.113.4", family: 4 }]),
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

const mServer = prisma.server as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};

type ActorVars = {
  Variables: { userId?: string; isAdmin?: boolean; authType?: string };
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
  name: "vps-1",
  host: "1.2.3.4",
  relayDomain: "relay.example.com",
  traefikEmail: "ops@example.com",
  sshUser: "root",
  sshPort: 22,
  sshPassword: "hunter2",
};

const asJson = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// We deliberately exercise *only* the pre-SSE early-return paths
// (auth, validation, uniqueness conflict). Anything past the
// `prisma.server.findUnique` check enters streamSSE → executeSshCommand
// territory which is covered by the install-relay service tests and
// would require a mock SSH server to drive end-to-end here.
describe("POST /servers/install-relay (pre-SSE gates)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated actor with 403", async () => {
    const res = await appFor({ userId: null, isAdmin: false }).request(
      "/servers/install-relay",
      asJson(validBody),
    );
    expect(res.status).toBe(403);
    expect(mServer.findUnique).not.toHaveBeenCalled();
  });

  it("non-admin reaches the uniqueness check (gate removed)", async () => {
    mServer.findUnique.mockResolvedValue({
      id: "srv-existing",
      name: "private-tenant-name",
      host: "1.2.3.4",
    });
    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/install-relay",
      asJson(validBody),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    // The non-admin must NOT see another tenant's server name.
    expect(body.message).not.toContain("private-tenant-name");
    expect(body.message).not.toContain("1.2.3.4");
    expect(mServer.findUnique).toHaveBeenCalledWith({ where: { host: "1.2.3.4" } });
  });

  it("admin sees the rich conflict message (server name + host)", async () => {
    mServer.findUnique.mockResolvedValue({
      id: "srv-existing",
      name: "fleet-server-3",
      host: "1.2.3.4",
    });
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/install-relay",
      asJson(validBody),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("fleet-server-3");
    expect(body.message).toContain("1.2.3.4");
  });

  it("non-admin cannot install against a literal private IP", async () => {
    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/install-relay",
      asJson({ ...validBody, host: "10.0.0.5" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("private_host");
    expect(mServer.findUnique).not.toHaveBeenCalled();
  });

  it("admin can install against a private IP (no host filter for admins)", async () => {
    mServer.findUnique.mockResolvedValue(null);
    // The admin path proceeds past the uniqueness check into streamSSE,
    // which we don't drive here — assert we got past the host filter
    // by checking that findUnique was consulted.
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/install-relay",
      asJson({ ...validBody, host: "192.168.1.10" }),
    );
    // streamSSE returns 200 with text/event-stream once entered.
    expect([200, 500]).toContain(res.status); // tolerant — the SSH layer will fail in test env
    expect(mServer.findUnique).toHaveBeenCalledWith({ where: { host: "192.168.1.10" } });
  });

  it("rejects non-JSON body with 400 for non-admin", async () => {
    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/install-relay",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      },
    );
    expect(res.status).toBe(400);
  });
});
