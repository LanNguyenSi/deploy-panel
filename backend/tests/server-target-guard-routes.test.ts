// The app, sync and v1 routes call the relay of a server the actor owns. A
// non-admin whose stored relayUrl is private (a row from before registration
// was checked, or a DNS change since) gets 400 private_host before any relay
// call; admins are not filtered.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// These tests assert route behaviour against a mocked global fetch; the
// connect-guarded transport (lib/guarded-fetch.ts) is covered in
// connect-guard.test.ts, so here it forwards to the same fetch.
vi.mock("../src/lib/guarded-fetch.js", () => ({
  guardedFetch: vi.fn((url: string, init?: RequestInit) => globalThis.fetch(url, init)),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    app: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({ id: "app-1", name: "myapp", status: "healthy" }),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    deploy: { create: vi.fn(), update: vi.fn().mockResolvedValue({}), findUnique: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

const lookupMock = vi.fn();
vi.mock("node:dns", () => ({
  promises: { lookup: (...args: unknown[]) => lookupMock(...args) },
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

const streamDeployMock = vi.fn();
vi.mock("../src/lib/stream-deploy.js", () => ({
  streamDeploy: (...args: unknown[]) => streamDeployMock(...args),
}));

import { prisma } from "../src/lib/prisma.js";
import { config } from "../src/config/index.js";
import { appsRouter } from "../src/routes/apps.js";
import { syncRouter } from "../src/routes/sync.js";
import { guardedFetch } from "../src/lib/guarded-fetch.js";
import { v1Router } from "../src/routes/v1.js";

const mServer = prisma.server as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
};
const mApp = prisma.app as unknown as { findUnique: ReturnType<typeof vi.fn> };
const mDeploy = prisma.deploy as unknown as { create: ReturnType<typeof vi.fn> };

const NON_ADMIN = { userId: "user-a", isAdmin: false };
const ADMIN = { userId: null, isAdmin: true };

function appFor(actor: { userId: string | null; isAdmin: boolean }) {
  const app = new Hono<{ Variables: { userId?: string; isAdmin?: boolean; authType?: string } }>();
  app.use("/*", async (c, next) => {
    if (actor.userId) c.set("userId", actor.userId);
    c.set("isAdmin", actor.isAdmin);
    c.set("authType", "session");
    await next();
  });
  app.route("/servers/:serverId/apps", appsRouter as unknown as Hono<any>);
  app.route("/servers", syncRouter as unknown as Hono<any>);
  app.route("/v1", v1Router as unknown as Hono<any>);
  return app;
}

const json = (method: string, body?: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "srv-a",
    userId: "user-a",
    name: "vps-a",
    host: "203.0.113.10",
    relayUrl: "https://relay.example.com",
    relayToken: "tok",
    ...overrides,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  config.TRUSTED_RELAY_SERVER_IDS.length = 0;
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "203.0.113.4", family: 4 }]);
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({ entries: [], apps: [], lines: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  mApp.findUnique.mockResolvedValue({ id: "app-1", name: "myapp", status: "healthy", requiredEnvKeys: [] });
  mDeploy.create.mockResolvedValue({ id: "dep-1" });
  mServer.findUnique.mockResolvedValue(row());
  mServer.findFirst.mockResolvedValue(row());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function expectDenied(res: Response) {
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string; field: string };
  expect(body.error).toBe("private_host");
  expect(body.field).toBe("relayUrl");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(streamDeployMock).not.toHaveBeenCalled();
}

const INTERNAL = "http://169.254.169.254/latest";

// [label, method, path, body]
const routes: Array<[string, string, string, unknown?]> = [
  ["apps GET env", "GET", "/servers/srv-a/apps/myapp/env"],
  ["apps PUT env", "PUT", "/servers/srv-a/apps/myapp/env", { entries: [{ key: "A", value: "1" }] }],
  ["apps POST deploy", "POST", "/servers/srv-a/apps/myapp/deploy", {}],
  ["apps GET logs", "GET", "/servers/srv-a/apps/myapp/logs"],
  ["apps POST rollback", "POST", "/servers/srv-a/apps/myapp/rollback", {}],
  ["apps GET preflight", "GET", "/servers/srv-a/apps/myapp/preflight"],
  ["sync POST", "POST", "/servers/srv-a/sync", {}],
  ["v1 POST deploy", "POST", "/v1/deploy", { server: "vps-a", app: "myapp" }],
  ["v1 POST rollback", "POST", "/v1/rollback", { server: "vps-a", app: "myapp" }],
  ["v1 GET logs", "GET", "/v1/logs?server=vps-a&app=myapp"],
  ["v1 POST preflight", "POST", "/v1/preflight", { server: "vps-a", app: "myapp" }],
];

describe("non-admin with a stored private relayUrl", () => {
  it.each(routes)("%s is rejected before any relay call", async (_label, method, path, body) => {
    mServer.findUnique.mockResolvedValue(row({ relayUrl: INTERNAL }));
    mServer.findFirst.mockResolvedValue(row({ relayUrl: INTERNAL }));
    const res = await appFor(NON_ADMIN).request(path, json(method, body));
    await expectDenied(res);
    expect(mDeploy.create).not.toHaveBeenCalled();
  });

  it("apps middleware also rejects a relayUrl whose name now resolves private", async () => {
    mServer.findUnique.mockResolvedValue(row({ relayUrl: "https://moved.example.com" }));
    lookupMock.mockResolvedValue([{ address: "10.4.4.4", family: 4 }]);
    const res = await appFor(NON_ADMIN).request("/servers/srv-a/apps/myapp/env");
    await expectDenied(res);
  });

  it("a server without a relayUrl is not rejected by the guard", async () => {
    mServer.findUnique.mockResolvedValue(row({ relayUrl: null }));
    const res = await appFor(NON_ADMIN).request("/servers/srv-a/sync", json("POST", {}));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("no_relay");
  });
});

describe("the same rows for an admin, and public rows for a non-admin", () => {
  it.each([
    ["apps GET env", "GET", "/servers/srv-a/apps/myapp/env"],
    ["v1 GET logs", "GET", "/v1/logs?server=vps-a&app=myapp"],
    ["sync POST", "POST", "/servers/srv-a/sync"],
  ] as Array<[string, string, string]>)("%s: admin still reaches the internal relay", async (_l, method, path) => {
    mServer.findUnique.mockResolvedValue(row({ userId: null, relayUrl: INTERNAL }));
    mServer.findFirst.mockResolvedValue(row({ userId: null, relayUrl: INTERNAL }));
    const res = await appFor(ADMIN).request(path, json(method, method === "POST" ? {} : undefined));
    await res.text();
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toContain("169.254.169.254");
  });

  it.each([
    ["apps GET env", "GET", "/servers/srv-a/apps/myapp/env"],
    ["v1 GET logs", "GET", "/v1/logs?server=vps-a&app=myapp"],
    ["sync POST", "POST", "/servers/srv-a/sync"],
  ] as Array<[string, string, string]>)("%s: a public relayUrl is called for a non-admin", async (_l, method, path) => {
    const res = await appFor(NON_ADMIN).request(path, json(method, method === "POST" ? {} : undefined));
    await res.text();
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toContain("relay.example.com");
  });

  it.each([
    ["apps GET env", "GET", "/servers/srv-a/apps/myapp/env"],
    ["v1 GET logs", "GET", "/v1/logs?server=vps-a&app=myapp"],
    ["sync POST", "POST", "/servers/srv-a/sync"],
  ] as Array<[string, string, string]>)("%s: the relay of an owned row goes through the guarded transport for a non-admin, not for an admin", async (_l, method, path) => {
    await (await appFor(NON_ADMIN).request(path, json(method, method === "POST" ? {} : undefined))).text();
    expect(guardedFetch).toHaveBeenCalled();
    expect(String(vi.mocked(guardedFetch).mock.calls[0][0])).toContain("relay.example.com");

    vi.mocked(guardedFetch).mockClear();
    fetchMock.mockClear();
    await (await appFor(ADMIN).request(path, json(method, method === "POST" ? {} : undefined))).text();
    expect(fetchMock).toHaveBeenCalled();
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("apps GET upstream: the relay listing of an owned row is guarded for a non-admin, not for an admin", async () => {
    const findMany = (prisma.app as unknown as { findMany: ReturnType<typeof vi.fn> }).findMany;
    findMany.mockResolvedValueOnce([{ name: "myapp" }]);
    await (await appFor(NON_ADMIN).request("/servers/srv-a/apps/upstream")).text();
    expect(guardedFetch).toHaveBeenCalledTimes(1);

    vi.mocked(guardedFetch).mockClear();
    findMany.mockResolvedValueOnce([{ name: "myapp" }]);
    await (await appFor(ADMIN).request("/servers/srv-a/apps/upstream")).text();
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("v1 POST deploy hands a public relayUrl to streamDeploy for a non-admin", async () => {
    const res = await appFor(NON_ADMIN).request("/v1/deploy", json("POST", { server: "vps-a", app: "myapp" }));
    expect(res.status).toBe(202);
    expect(streamDeployMock).toHaveBeenCalledTimes(1);
    expect(streamDeployMock.mock.calls[0][0]).toMatchObject({ connectGuard: true });
  });

  it("v1 POST deploy for an admin, and for a listed id, does not ask for the connect-time guard", async () => {
    await appFor(ADMIN).request("/v1/deploy", json("POST", { server: "vps-a", app: "myapp" }));
    expect(streamDeployMock.mock.calls.at(-1)![0]).toMatchObject({ connectGuard: false });
    config.TRUSTED_RELAY_SERVER_IDS.push("srv-a");
    await appFor(NON_ADMIN).request("/v1/deploy", json("POST", { server: "vps-a", app: "myapp" }));
    expect(streamDeployMock.mock.calls.at(-1)![0]).toMatchObject({ connectGuard: false });
  });
});

describe("TRUSTED_RELAY_SERVER_IDS exempts a listed server's stored private relayUrl", () => {
  function usePrivateRow() {
    mServer.findUnique.mockResolvedValue(row({ relayUrl: INTERNAL }));
    mServer.findFirst.mockResolvedValue(row({ relayUrl: INTERNAL }));
  }

  it.each(routes)("%s: an id that is not listed is still rejected", async (_label, method, path, body) => {
    config.TRUSTED_RELAY_SERVER_IDS.push("srv-other");
    usePrivateRow();
    const res = await appFor(NON_ADMIN).request(path, json(method, body));
    await expectDenied(res);
  });

  it.each(routes)("%s: a listed id proceeds to the relay", async (_label, method, path, body) => {
    config.TRUSTED_RELAY_SERVER_IDS.push("srv-other", "srv-a");
    usePrivateRow();
    const res = await appFor(NON_ADMIN).request(path, json(method, body));
    await res.text();
    expect(fetchMock.mock.calls.length + streamDeployMock.mock.calls.length).toBeGreaterThan(0);
  });

  it("the apps middleware lists apps (200) for a listed id on a private relayUrl", async () => {
    config.TRUSTED_RELAY_SERVER_IDS.push("srv-a");
    usePrivateRow();
    const res = await appFor(NON_ADMIN).request("/servers/srv-a/apps");
    expect(res.status).toBe(200);
  });

  it("the apps list is refused for the same row when the id is not listed", async () => {
    usePrivateRow();
    const res = await appFor(NON_ADMIN).request("/servers/srv-a/apps");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("private_host");
  });

  it("a listed id with a hostname that resolves private is exempt too", async () => {
    config.TRUSTED_RELAY_SERVER_IDS.push("srv-a");
    mServer.findUnique.mockResolvedValue(row({ relayUrl: "http://agent-relay:8222" }));
    lookupMock.mockResolvedValue([{ address: "172.18.0.5", family: 4 }]);
    const res = await appFor(NON_ADMIN).request("/servers/srv-a/sync", json("POST", {}));
    await res.text();
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toContain("agent-relay:8222");
  });
});
