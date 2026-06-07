import { describe, expect, it, vi, beforeEach } from "vitest";

// The /logs and /preflight handlers interpolate the :name path param straight
// into the relay request path (`/api/apps/${name}/logs`). Without the
// APP_NAME_PATTERN guard a caller can smuggle extra path/query segments into
// the relay request (path / SSRF injection), e.g. a name like `x?cmd=evil`.
// These tests pin the guard: a name that fails the pattern must 400 BEFORE
// any relay round-trip, and a clean name must still reach the relay.

vi.mock("../src/lib/relay.js", () => ({
  relayRequest: vi.fn(),
  RelayError: class RelayError extends Error {
    status: number;
    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("../src/lib/ownership.js", () => ({
  getActorContext: vi.fn(() => ({ userId: "user-a", isAdmin: false })),
  findOwnedServer: vi.fn(async () => ({ id: "srv-a", userId: "user-a" })),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    app: { findMany: vi.fn(), upsert: vi.fn() },
    deploy: { create: vi.fn(), findFirst: vi.fn() },
    server: { findUnique: vi.fn() },
    envVarChange: { createMany: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock("../src/lib/audit.js", () => ({
  audit: vi.fn(),
  getActor: vi.fn(() => "panel"),
  getActorUserId: vi.fn(() => "user-a"),
}));

vi.mock("../src/lib/stream-deploy.js", () => ({ streamDeploy: vi.fn() }));
vi.mock("../src/lib/deploy-recovery.js", () => ({ recoverBrokenDeploy: vi.fn() }));

import { relayRequest } from "../src/lib/relay.js";
import { appsRouter } from "../src/routes/apps.js";
import { Hono } from "hono";

const mRelay = relayRequest as unknown as ReturnType<typeof vi.fn>;

function app() {
  const a = new Hono();
  a.route("/servers/:serverId/apps", appsRouter as unknown as Hono);
  return a;
}

describe("apps router app-name validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /:name/logs rejects an invalid app name without hitting the relay", async () => {
    const res = await app().request("/servers/srv-a/apps/bad.name/logs");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_app_name" });
    expect(mRelay).not.toHaveBeenCalled();
  });

  it("GET /:name/preflight rejects an invalid app name without hitting the relay", async () => {
    const res = await app().request("/servers/srv-a/apps/bad.name/preflight");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_app_name" });
    expect(mRelay).not.toHaveBeenCalled();
  });

  it("GET /:name/logs allows a clean app name through to the relay", async () => {
    mRelay.mockResolvedValueOnce({ logs: [] });
    const res = await app().request("/servers/srv-a/apps/good-name/logs");
    expect(res.status).toBe(200);
    expect(mRelay).toHaveBeenCalledTimes(1);
    expect(mRelay.mock.calls[0]?.[0]?.path).toBe("/api/apps/good-name/logs?lines=50");
  });
});
