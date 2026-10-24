import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * relayUrl output pin across the zod 3 -> 4 migration (POST /api/servers and
 * PATCH /api/servers/:id).
 *
 * zod 4's `z.url()` returns a CLEANED value (leading/trailing whitespace
 * trimmed, ASCII tabs and newlines removed) where zod 3's `.url()` returned the
 * input byte for byte. The panel stores relayUrl verbatim, so the value handed
 * to `prisma.server.create` / `prisma.server.update` must equal the request
 * value exactly, as it did on the base. Each whitespace input is its own case;
 * a `.url()` that cleans (plain zod 4) would fail every one of them.
 */

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
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
    BACKEND_URL: "http://localhost:3001",
    PORT: 3001,
    ALLOWED_GITHUB_LOGINS: "",
  },
  allowedGitHubLogins: [],
  hasGitHubOAuthConfigured: false,
}));

import { Hono } from "hono";
import { prisma } from "../src/lib/prisma.js";
import { serversRouter } from "../src/routes/servers.js";

type ActorVars = { Variables: { userId?: string; isAdmin?: boolean; authType?: string } };

const create = prisma.server.create as unknown as ReturnType<typeof vi.fn>;
const update = prisma.server.update as unknown as ReturnType<typeof vi.fn>;
const findUnique = prisma.server.findUnique as unknown as ReturnType<typeof vi.fn>;

function app() {
  const a = new Hono<ActorVars>();
  a.use("/*", async (c, next) => {
    c.set("isAdmin", true);
    await next();
  });
  a.route("/api/servers", serversRouter as unknown as Hono<ActorVars>);
  return a;
}

const storedServer = (relayUrl: string) => ({
  id: "srv-1",
  name: "s",
  host: "h",
  relayUrl,
  relayToken: null,
  sshKeyPath: null,
  hostKeySha256: null,
});

const post = (relayUrl: string) =>
  app().request(
    "/api/servers",
    new Request("http://x/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "s", host: "h", relayUrl }),
    }),
  );

const patch = (relayUrl: string) =>
  app().request(
    "/api/servers/srv-1",
    new Request("http://x/api/servers/srv-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relayUrl }),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue(storedServer("x"));
  update.mockResolvedValue(storedServer("x"));
});

describe("POST /api/servers keeps relayUrl byte for byte (v3 url output)", () => {
  const relayUrlAtPrisma = () => create.mock.calls[0][0].data.relayUrl;

  it("leading space: prisma create receives \" http://x\"", async () => {
    findUnique.mockResolvedValue(null);
    const res = await post(" http://x");
    expect(res.status).toBe(201);
    expect(relayUrlAtPrisma()).toBe(" http://x");
    expect(relayUrlAtPrisma()).not.toBe("http://x");
  });

  it("trailing space: prisma create receives \"http://x \"", async () => {
    findUnique.mockResolvedValue(null);
    const res = await post("http://x ");
    expect(res.status).toBe(201);
    expect(relayUrlAtPrisma()).toBe("http://x ");
    expect(relayUrlAtPrisma()).not.toBe("http://x");
  });

  it("trailing newline: prisma create receives \"http://x\\n\"", async () => {
    findUnique.mockResolvedValue(null);
    const res = await post("http://x\n");
    expect(res.status).toBe(201);
    expect(relayUrlAtPrisma()).toBe("http://x\n");
    expect(relayUrlAtPrisma()).not.toBe("http://x");
  });

  it("leading tab: prisma create receives \"\\thttp://x\"", async () => {
    findUnique.mockResolvedValue(null);
    const res = await post("\thttp://x");
    expect(res.status).toBe(201);
    expect(relayUrlAtPrisma()).toBe("\thttp://x");
    expect(relayUrlAtPrisma()).not.toBe("http://x");
  });

  it("internal tab: prisma create receives \"http://x\\t/y\"", async () => {
    findUnique.mockResolvedValue(null);
    const res = await post("http://x\t/y");
    expect(res.status).toBe(201);
    expect(relayUrlAtPrisma()).toBe("http://x\t/y");
    expect(relayUrlAtPrisma()).not.toBe("http://x/y");
  });
});

describe("PATCH /api/servers/:id keeps relayUrl byte for byte (v3 url output)", () => {
  const relayUrlAtPrisma = () => update.mock.calls[0][0].data.relayUrl;

  it("leading space: prisma update receives \" http://x\"", async () => {
    findUnique.mockResolvedValue(storedServer("x"));
    const res = await patch(" http://x");
    expect(res.status).toBe(200);
    expect(relayUrlAtPrisma()).toBe(" http://x");
    expect(relayUrlAtPrisma()).not.toBe("http://x");
  });

  it("trailing space: prisma update receives \"http://x \"", async () => {
    findUnique.mockResolvedValue(storedServer("x"));
    const res = await patch("http://x ");
    expect(res.status).toBe(200);
    expect(relayUrlAtPrisma()).toBe("http://x ");
    expect(relayUrlAtPrisma()).not.toBe("http://x");
  });

  it("trailing newline: prisma update receives \"http://x\\n\"", async () => {
    findUnique.mockResolvedValue(storedServer("x"));
    const res = await patch("http://x\n");
    expect(res.status).toBe(200);
    expect(relayUrlAtPrisma()).toBe("http://x\n");
    expect(relayUrlAtPrisma()).not.toBe("http://x");
  });

  it("leading tab: prisma update receives \"\\thttp://x\"", async () => {
    findUnique.mockResolvedValue(storedServer("x"));
    const res = await patch("\thttp://x");
    expect(res.status).toBe(200);
    expect(relayUrlAtPrisma()).toBe("\thttp://x");
    expect(relayUrlAtPrisma()).not.toBe("http://x");
  });

  it("internal tab: prisma update receives \"http://x\\t/y\"", async () => {
    findUnique.mockResolvedValue(storedServer("x"));
    const res = await patch("http://x\t/y");
    expect(res.status).toBe(200);
    expect(relayUrlAtPrisma()).toBe("http://x\t/y");
    expect(relayUrlAtPrisma()).not.toBe("http://x/y");
  });
});
