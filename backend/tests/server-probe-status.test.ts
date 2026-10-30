// relay probes distinguish auth (401/403) and transient failures
// (404/5xx/timeout) from offline (refused/DNS). POST /api/servers/:id/test
// and POST /api/servers/:serverId/sync must persist and report that
// taxonomy; only a genuinely unreachable relay is "offline".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    app: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
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

// setServerStatus is stubbed (its own coordination logic is covered by
// server-status.test.ts) but the two classification helpers stay REAL:
// they are what this test pins per branch.
vi.mock("../src/services/server-status.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/server-status.js")>(
    "../src/services/server-status.js",
  );
  return { ...actual, setServerStatus: vi.fn().mockResolvedValue(true) };
});

// getLatestRelayRevision would fetch GHCR over the network; stub it.
vi.mock("../src/lib/ghcr.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/ghcr.js")>(
    "../src/lib/ghcr.js",
  );
  return { ...actual, getLatestRelayRevision: vi.fn().mockResolvedValue(null) };
});

import { prisma } from "../src/lib/prisma.js";
import { serversRouter } from "../src/routes/servers.js";
import { syncRouter } from "../src/routes/sync.js";
import { setServerStatus } from "../src/services/server-status.js";

const mServer = prisma.server as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
};
const mSetStatus = vi.mocked(setServerStatus);

type ActorVars = {
  Variables: { userId?: string; isAdmin?: boolean; authType?: string };
};

function appFor() {
  const app = new Hono<ActorVars>();
  app.use("/*", async (c, next) => {
    c.set("isAdmin", true);
    await next();
  });
  app.route("/servers", serversRouter as unknown as Hono<ActorVars>);
  app.route("/servers", syncRouter as unknown as Hono<ActorVars>);
  return app;
}

const OWNED_SERVER = {
  id: "srv-1",
  userId: null,
  name: "prod-vps",
  host: "203.0.113.10",
  status: "unknown",
  relayUrl: "https://relay.example.test",
  relayToken: "secret-relay-token",
  sshKeyPath: null,
  hostKeySha256: null,
  relayMode: null,
  relayDir: null,
  relayComposeFile: null,
  lastSeenAt: null,
};

// The undici fetch failure for a refused connection / DNS error: a
// TypeError("fetch failed"). A fired AbortSignal.timeout rejects with a
// TimeoutError DOMException instead.
function refusedError() {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED 203.0.113.10:443"), {
      code: "ECONNREFUSED",
    }),
  });
}

function timeoutError() {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

beforeEach(() => {
  vi.clearAllMocks();
  mServer.findUnique.mockResolvedValue(OWNED_SERVER as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /servers/:id/test status taxonomy", () => {
  async function testOnce(fetchImpl: (input: unknown, init?: unknown) => unknown) {
    vi.stubGlobal("fetch", vi.fn(fetchImpl));
    const res = await appFor().request("/servers/srv-1/test", { method: "POST" });
    return { res, body: await res.json() };
  }

  it("200 keeps online", async () => {
    const { res, body } = await testOnce(() =>
      Response.json({ status: "ok", version: "1.0.0", revision: "abc1234" }),
    );
    expect(res.status).toBe(200);
    expect(body.status).toBe("online");
    expect(mSetStatus).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv-1", status: "online" }),
    );
  });

  it("401 writes auth and the message names the relay token", async () => {
    const { res, body } = await testOnce(() => new Response("nope", { status: 401 }));
    expect(res.status).toBe(200);
    expect(body.status).toBe("auth");
    expect(body.message).toContain("check the relay token");
    expect(body.message).toContain("401");
    expect(mSetStatus).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv-1", status: "auth" }),
    );
  });

  it("403 writes auth too", async () => {
    const { body } = await testOnce(() => new Response("nope", { status: 403 }));
    expect(body.status).toBe("auth");
    expect(mSetStatus).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv-1", status: "auth" }),
    );
  });

  it("404 writes unknown (relay answered, so not offline)", async () => {
    const { body } = await testOnce(() => new Response("missing", { status: 404 }));
    expect(body.status).toBe("unknown");
    expect(body.message).toBe("Relay responded with 404");
    expect(mSetStatus).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv-1", status: "unknown" }),
    );
  });

  it("503 writes unknown", async () => {
    const { body } = await testOnce(() => new Response("down", { status: 503 }));
    expect(body.status).toBe("unknown");
    expect(body.message).toBe("Relay responded with 503");
    expect(mSetStatus).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv-1", status: "unknown" }),
    );
  });

  it("probe timeout writes unknown, not offline", async () => {
    const { body } = await testOnce(() => Promise.reject(timeoutError()));
    expect(body.status).toBe("unknown");
    expect(body.message).toContain("timeout");
    expect(mSetStatus).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv-1", status: "unknown" }),
    );
  });

  it("connection refused stays offline", async () => {
    const { body } = await testOnce(() => Promise.reject(refusedError()));
    expect(body.status).toBe("offline");
    expect(body.message).toBe("fetch failed");
    expect(mSetStatus).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv-1", status: "offline" }),
    );
  });
});

describe("POST /servers/:serverId/sync status taxonomy", () => {
  async function syncOnce(fetchImpl: (input: unknown, init?: unknown) => unknown) {
    vi.stubGlobal("fetch", vi.fn(fetchImpl));
    const res = await appFor().request("/servers/srv-1/sync", { method: "POST" });
    return { res, body: await res.json() };
  }

  it("relay 401 writes auth and the error message says why", async () => {
    const { res, body } = await syncOnce(() => new Response("unauthorized", { status: 401 }));
    expect(res.status).toBe(500);
    expect(body.status).toBe("auth");
    expect(body.error).toContain("401");
    expect(mSetStatus).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv-1", status: "auth" }),
    );
  });

  it("connection refused stays offline", async () => {
    const { res, body } = await syncOnce(() => Promise.reject(refusedError()));
    expect(res.status).toBe(500);
    expect(body.status).toBe("offline");
    expect(mSetStatus).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv-1", status: "offline" }),
    );
  });

  it("a reachable relay still writes online on success", async () => {
    const { res, body } = await syncOnce(() => Response.json({ apps: [] }));
    expect(res.status).toBe(200);
    expect(body.synced).toBe(true);
    expect(mSetStatus).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv-1", status: "online" }),
    );
  });
});