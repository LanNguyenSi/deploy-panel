// Route-level encryption-at-rest coverage for `Server.relayToken`
// (lib/relay-token.ts): the write paths store ciphertext (POST /api/servers,
// PATCH /api/servers/:id; the install and re-install writes are covered in
// install-relay-route.test.ts and reinstall-relay-route.test.ts), and the
// GET /api/servers/:id/system read opens it before sending the bearer.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

// Public DNS answer so the non-admin target checks stay inert.
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
    TRUSTED_RELAY_SERVER_IDS: [] as string[],
  },
  allowedGitHubLogins: [],
}));

import { prisma } from "../src/lib/prisma.js";
import { serversRouter } from "../src/routes/servers.js";
import { openRelayToken, sealRelayToken } from "../src/lib/relay-token.js";
import { Hono } from "hono";

const mServer = prisma.server as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

type ActorVars = { Variables: { userId?: string; isAdmin?: boolean; authType?: string } };

function appFor(actor: { userId: string | null; isAdmin: boolean } = { userId: null, isAdmin: true }) {
  const app = new Hono<ActorVars>();
  app.use("/*", async (c, next) => {
    if (actor.userId) c.set("userId", actor.userId);
    c.set("isAdmin", actor.isAdmin);
    await next();
  });
  app.route("/servers", serversRouter as unknown as Hono<ActorVars>);
  return app;
}

const asJson = (method: string, body: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const row = (relayToken: string | null) => ({
  id: "srv-a",
  userId: null,
  name: "a",
  host: "a.example",
  relayUrl: "https://relay.example.com",
  relayToken,
  hostKeySha256: null,
  relayMode: null,
  status: "online",
  sshKeyPath: null,
  lastSeenAt: null,
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/servers seals a submitted relayToken", () => {
  it("stores ciphertext, not the submitted plaintext", async () => {
    mServer.findUnique.mockResolvedValue(null); // host uniqueness probe
    mServer.create.mockResolvedValue(row("ignored"));
    const res = await appFor().request(
      "/servers",
      asJson("POST", { name: "vps", host: "203.0.113.7", relayUrl: "https://relay.example.com", relayToken: "PLAIN-SUBMITTED-token" }),
    );
    expect(res.status).toBe(201);
    const stored = mServer.create.mock.calls[0]?.[0].data.relayToken;
    expect(stored).not.toBe("PLAIN-SUBMITTED-token");
    expect(openRelayToken(stored)).toBe("PLAIN-SUBMITTED-token");
    // The response never carries the token in any form.
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("PLAIN-SUBMITTED-token");
    expect(JSON.stringify(body)).not.toContain(stored);
    expect(body.server.hasRelayToken).toBe(true);
  });

  it("a create without relayToken stores no relayToken key", async () => {
    mServer.findUnique.mockResolvedValue(null);
    mServer.create.mockResolvedValue(row(null));
    const res = await appFor().request(
      "/servers",
      asJson("POST", { name: "vps", host: "203.0.113.8" }),
    );
    expect(res.status).toBe(201);
    expect(mServer.create.mock.calls[0]?.[0].data.relayToken).toBeUndefined();
  });
});

describe("PATCH /api/servers/:id seals a submitted relayToken", () => {
  it("stores ciphertext opened back to the submitted plaintext", async () => {
    mServer.findUnique.mockResolvedValue(row("old-or-null"));
    mServer.update.mockResolvedValue(row("ignored"));
    const res = await appFor().request("/servers/srv-a", asJson("PATCH", { relayToken: "NEW-PLAIN-token" }));
    expect(res.status).toBe(200);
    const data = mServer.update.mock.calls[0]?.[0].data;
    expect(data.relayToken).not.toBe("NEW-PLAIN-token");
    expect(openRelayToken(data.relayToken)).toBe("NEW-PLAIN-token");
  });

  it("a PATCH without relayToken never writes the column", async () => {
    mServer.findUnique.mockResolvedValue(row("untouched"));
    mServer.update.mockResolvedValue(row("untouched"));
    const res = await appFor().request("/servers/srv-a", asJson("PATCH", { name: "renamed" }));
    expect(res.status).toBe(200);
    expect(mServer.update.mock.calls[0]?.[0].data.relayToken).toBeUndefined();
  });
});

describe("GET /api/servers/:id/system", () => {
  it("opens the sealed stored token before sending the bearer", async () => {
    mServer.findUnique.mockResolvedValue(row(sealRelayToken("system-bearer-token")));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ cpu: 1 }));
    const res = await appFor().request("/servers/srv-a/system");
    expect(res.status).toBe(200);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: "Bearer system-bearer-token" });
    fetchSpy.mockRestore();
  });

  it("a stored value that does not open answers 502 and never issues the fetch", async () => {
    mServer.findUnique.mockResolvedValue(row("v1:AAA:BBB:CCC"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    const res = await appFor().request("/servers/srv-a/system");
    expect(res.status).toBe(502);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

// Guards the invariant every fixture above leans on: sealing is per-call
// (random IV), so a stored value equal to its own plaintext would mean the
// write path bypassed sealRelayToken.
describe("write-path guard", () => {
  it("sealRelayToken output is never equal to its input", () => {
    expect(sealRelayToken("x")).not.toBe("x");
  });
});
