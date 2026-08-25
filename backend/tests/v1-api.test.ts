import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    app: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    deploy: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("../src/lib/relay.js", () => ({
  relayRequest: vi.fn(),
  RelayError: class RelayError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "RelayError";
      this.status = status;
    }
  },
}));

vi.mock("../src/lib/stream-deploy.js", () => ({
  streamDeploy: vi.fn(),
}));

vi.mock("../src/lib/audit.js", () => ({
  audit: vi.fn(),
  getActorUserId: vi.fn().mockReturnValue(null),
}));

vi.mock("../src/lib/deploy-recovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/deploy-recovery.js")>();
  return {
    ...actual,
    // Only recoverBrokenDeploy is stubbed. The registerActiveDeploy/
    // releaseActiveDeploy/isActiveDeploy helpers and readExistingSteps are
    // kept real (via spread) rather than replaced by a partial factory: a
    // partial factory used to leave readExistingSteps undefined here, which
    // made startup.ts's recoverStuckDeploys throw (swallowed by its
    // per-record try/catch) before ever reaching prisma.deploy.updateMany
    // whenever a candidate row slipped past the active-deploy-registry
    // exclusion, masking exactly the registration mutants the
    // "active-deploy registration" describe block below exists to catch,
    // since the assertion `updateMany not called` then passed for the
    // wrong reason.
    //
    // Resolves a real promise (not a bare vi.fn(), which returns
    // undefined): the route now calls `.catch(...)` on recoverBrokenDeploy's
    // return value (fire-and-forget with its own rejection guard), and
    // undefined.catch(...) throws.
    recoverBrokenDeploy: vi.fn().mockResolvedValue(undefined),
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
import { relayRequest, RelayError } from "../src/lib/relay.js";
import { streamDeploy } from "../src/lib/stream-deploy.js";
import {
  recoverBrokenDeploy,
  registerActiveDeploy,
  releaseActiveDeploy,
  isActiveDeploy,
  clearActiveDeploys,
} from "../src/lib/deploy-recovery.js";
import { recoverStuckDeploys } from "../src/lib/startup.js";
import { v1Router } from "../src/routes/v1.js";
import { Hono } from "hono";

type ActorVars = {
  Variables: {
    userId?: string;
    isAdmin?: boolean;
    authType?: string;
    apiKeyName?: string;
  };
};

const mServer = prisma.server as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
};
const mApp = prisma.app as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mDeploy = prisma.deploy as unknown as {
  create: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
};

function appFor(actor: { userId: string | null; isAdmin: boolean }) {
  const app = new Hono<ActorVars>();
  app.use("/*", async (c, next) => {
    if (actor.userId) c.set("userId", actor.userId);
    c.set("isAdmin", actor.isAdmin);
    c.set("authType", "panel");
    await next();
  });
  app.route("/", v1Router as any);
  return app;
}

// Reusable fixtures
const ownedServer = {
  id: "srv-a",
  userId: "user-a",
  name: "my-server",
  host: "a.example",
  relayUrl: "http://relay.example",
  relayToken: "relay-tok",
  status: "online",
  lastSeenAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  sshKeyPath: null,
  hostKeySha256: null,
  relayMode: null,
  relayDir: null,
  relayComposeFile: null,
};

const appRecord = {
  id: "app-a",
  name: "my-app",
  serverId: "srv-a",
  path: "/apps/my-app",
  status: "healthy",
  tag: null,
  lastDeployAt: null,
  repoUrl: null,
  branch: "main",
  health: null,
  liveUrl: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ── GET /servers ownership ────────────────────────────────────────────────────

describe("v1 GET /servers — ownership filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("admin actor: unfiltered query (no where.userId or where.id restriction)", async () => {
    mServer.findMany.mockResolvedValue([]);
    await appFor({ userId: null, isAdmin: true }).request("/servers");
    const where = mServer.findMany.mock.calls[0]?.[0]?.where ?? {};
    expect(where.userId).toBeUndefined();
    expect(where.id).toBeUndefined();
  });

  it("non-admin with userId: where.userId === actor.userId", async () => {
    mServer.findMany.mockResolvedValue([]);
    await appFor({ userId: "user-a", isAdmin: false }).request("/servers");
    const where = mServer.findMany.mock.calls[0]?.[0]?.where;
    expect(where?.userId).toBe("user-a");
  });

  it("non-admin WITHOUT userId: __no_access__ fallback (safety branch — must match nothing)", async () => {
    mServer.findMany.mockResolvedValue([]);
    await appFor({ userId: null, isAdmin: false }).request("/servers");
    const where = mServer.findMany.mock.calls[0]?.[0]?.where;
    // Must carry `id: "__no_access__"` so the query matches zero rows even
    // when no userId is bound — prevents accidental all-rows exposure.
    expect(where?.id).toBe("__no_access__");
    expect(where?.userId).toBeUndefined();
  });
});

// ── GET /apps ownership ───────────────────────────────────────────────────────

describe("v1 GET /apps — ownership filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("admin actor: no where.server filter", async () => {
    mApp.findMany.mockResolvedValue([]);
    await appFor({ userId: null, isAdmin: true }).request("/apps");
    const where = mApp.findMany.mock.calls[0]?.[0]?.where ?? {};
    expect(where.server).toBeUndefined();
  });

  it("non-admin with userId: apps filtered through server ownership", async () => {
    mApp.findMany.mockResolvedValue([]);
    await appFor({ userId: "user-a", isAdmin: false }).request("/apps");
    const where = mApp.findMany.mock.calls[0]?.[0]?.where;
    expect(where?.server).toEqual({ userId: "user-a" });
  });

  it("non-admin WITHOUT userId: __no_access__ fallback in server filter", async () => {
    mApp.findMany.mockResolvedValue([]);
    await appFor({ userId: null, isAdmin: false }).request("/apps");
    const where = mApp.findMany.mock.calls[0]?.[0]?.where;
    expect(where?.server).toEqual({ userId: "__no_access__" });
  });

  // Regression coverage for the MCP name-resolution fix: server_id used to
  // be passed straight into a raw Prisma `{ serverId }` filter, so a server
  // NAME (rather than its id) silently matched zero apps. It must now
  // resolve through findOwnedServerByIdOrName like the other v1 routes.
  it("server_id=<name>: resolves via findOwnedServerByIdOrName and filters by the resolved id", async () => {
    mServer.findFirst.mockResolvedValue(ownedServer);
    mApp.findMany.mockResolvedValue([]);

    await appFor({ userId: "user-a", isAdmin: false }).request("/apps?server_id=my-server");

    expect(mServer.findFirst).toHaveBeenCalledWith({
      where: { OR: [{ id: "my-server" }, { name: "my-server" }] },
    });
    const where = mApp.findMany.mock.calls[0]?.[0]?.where;
    expect(where?.serverId).toBe("srv-a");
  });

  it("server_id=<id>: resolves the same way when passed the server's actual id", async () => {
    mServer.findFirst.mockResolvedValue(ownedServer);
    mApp.findMany.mockResolvedValue([]);

    await appFor({ userId: "user-a", isAdmin: false }).request("/apps?server_id=srv-a");

    expect(mServer.findFirst).toHaveBeenCalledWith({
      where: { OR: [{ id: "srv-a" }, { name: "srv-a" }] },
    });
    const where = mApp.findMany.mock.calls[0]?.[0]?.where;
    expect(where?.serverId).toBe("srv-a");
  });

  it("server_id that does not resolve (unowned or unknown): 404s like the five sibling v1 routes, without ever calling app.findMany with a raw unresolved filter", async () => {
    mServer.findFirst.mockResolvedValue(null);

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/apps?server_id=nope");

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("not_found");
    expect(body.message).toContain("nope");
    expect(mApp.findMany).not.toHaveBeenCalled();
  });
});

// ── GET /deploys ownership ────────────────────────────────────────────────────

describe("v1 GET /deploys — ownership filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("admin actor: no where.server filter", async () => {
    mDeploy.findMany.mockResolvedValue([]);
    mDeploy.count.mockResolvedValue(0);
    await appFor({ userId: null, isAdmin: true }).request("/deploys");
    const where = mDeploy.findMany.mock.calls[0]?.[0]?.where ?? {};
    expect(where.server).toBeUndefined();
  });

  it("non-admin with userId: deploys filtered through server ownership", async () => {
    mDeploy.findMany.mockResolvedValue([]);
    mDeploy.count.mockResolvedValue(0);
    await appFor({ userId: "user-a", isAdmin: false }).request("/deploys");
    const where = mDeploy.findMany.mock.calls[0]?.[0]?.where;
    expect(where?.server).toEqual({ userId: "user-a" });
  });

  it("non-admin WITHOUT userId: __no_access__ fallback in deploys server filter", async () => {
    mDeploy.findMany.mockResolvedValue([]);
    mDeploy.count.mockResolvedValue(0);
    await appFor({ userId: null, isAdmin: false }).request("/deploys");
    const where = mDeploy.findMany.mock.calls[0]?.[0]?.where;
    expect(where?.server).toEqual({ userId: "__no_access__" });
  });

  // Regression coverage for the same name-resolution fix as GET /apps
  // (backend/src/routes/v1.ts): server_id used to be passed straight into
  // a raw Prisma `{ serverId }` filter, so a server NAME silently matched
  // zero deploys. It must now resolve through findOwnedServerByIdOrName
  // like the other v1 routes.
  it("server_id=<name>: resolves via findOwnedServerByIdOrName and filters by the resolved id", async () => {
    mServer.findFirst.mockResolvedValue(ownedServer);
    mDeploy.findMany.mockResolvedValue([]);
    mDeploy.count.mockResolvedValue(0);

    await appFor({ userId: "user-a", isAdmin: false }).request("/deploys?server_id=my-server");

    expect(mServer.findFirst).toHaveBeenCalledWith({
      where: { OR: [{ id: "my-server" }, { name: "my-server" }] },
    });
    const where = mDeploy.findMany.mock.calls[0]?.[0]?.where;
    expect(where?.serverId).toBe("srv-a");
  });

  it("server_id=<id>: resolves the same way when passed the server's actual id", async () => {
    mServer.findFirst.mockResolvedValue(ownedServer);
    mDeploy.findMany.mockResolvedValue([]);
    mDeploy.count.mockResolvedValue(0);

    await appFor({ userId: "user-a", isAdmin: false }).request("/deploys?server_id=srv-a");

    expect(mServer.findFirst).toHaveBeenCalledWith({
      where: { OR: [{ id: "srv-a" }, { name: "srv-a" }] },
    });
    const where = mDeploy.findMany.mock.calls[0]?.[0]?.where;
    expect(where?.serverId).toBe("srv-a");
  });

  it("server_id that does not resolve (unowned or unknown): 404s without ever calling deploy.findMany with a raw unresolved filter", async () => {
    mServer.findFirst.mockResolvedValue(null);

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/deploys?server_id=nope");

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("not_found");
    expect(body.message).toContain("nope");
    expect(mDeploy.findMany).not.toHaveBeenCalled();
  });

  it("server_id belonging to a different owner: 404, deploy.findMany not called", async () => {
    mServer.findFirst.mockResolvedValue({ ...ownedServer, userId: "user-b" });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/deploys?server_id=my-server");

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("not_found");
    expect(mDeploy.findMany).not.toHaveBeenCalled();
  });

  it("app_id stays a raw Prisma filter (no name resolution attempted)", async () => {
    mDeploy.findMany.mockResolvedValue([]);
    mDeploy.count.mockResolvedValue(0);

    await appFor({ userId: "user-a", isAdmin: false }).request("/deploys?app_id=app-a");

    const where = mDeploy.findMany.mock.calls[0]?.[0]?.where;
    expect(where?.appId).toBe("app-a");
    expect(mServer.findFirst).not.toHaveBeenCalled();
  });
});

// ── POST /deploy ──────────────────────────────────────────────────────────────

describe("v1 POST /deploy — core flow and ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("owned server: deploy.create with status=running, correct serverId/appId, and streamDeploy invoked", async () => {
    const deployRecord = { id: "deploy-1", status: "running", serverId: "srv-a", appId: "app-a" };
    mServer.findFirst.mockResolvedValue(ownedServer);
    mApp.findUnique.mockResolvedValue(appRecord);
    mDeploy.create.mockResolvedValue(deployRecord);
    mApp.update.mockResolvedValue({});

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "my-server", app: "my-app" }),
    });

    expect(res.status).toBe(202);
    expect(mDeploy.create).toHaveBeenCalledOnce();
    const createData = mDeploy.create.mock.calls[0][0].data;
    expect(createData.status).toBe("running");
    expect(createData.serverId).toBe("srv-a");
    expect(createData.appId).toBe("app-a");
    expect(mApp.update).toHaveBeenCalledOnce();
    expect(streamDeploy).toHaveBeenCalledOnce();

    const body = (await res.json()) as { deploy: { id: string; status: string } };
    expect(body.deploy.status).toBe("running");
  });

  it("non-owned server: 404, no deploy created (ownership gate)", async () => {
    // Server exists but belongs to a different user — findOwnedServerByIdOrName returns null
    mServer.findFirst.mockResolvedValue({ ...ownedServer, userId: "user-b" });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "srv-b", app: "my-app" }),
    });

    expect(res.status).toBe(404);
    expect(mDeploy.create).not.toHaveBeenCalled();
    expect(streamDeploy).not.toHaveBeenCalled();
  });

  it("missing server param: returns 400", async () => {
    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app: "my-app" }),
    });
    expect(res.status).toBe(400);
  });

  it("path-traversal app name: 400, no deploy/relay side effects (APP_NAME_PATTERN guard)", async () => {
    // appName is interpolated into the relay path `/api/apps/${appName}/deploy`,
    // so the regex guard is security-relevant. Rejection must happen BEFORE any
    // ownership lookup or relay call.
    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "my-server", app: "../../etc/passwd" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
    expect(mDeploy.create).not.toHaveBeenCalled();
    expect(streamDeploy).not.toHaveBeenCalled();
  });
});

// ── GET /deploy/:id ───────────────────────────────────────────────────────────

describe("v1 GET /deploy/:id — foreign-server isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when the deploy's server belongs to another user", async () => {
    mDeploy.findUnique.mockResolvedValue({
      id: "deploy-1",
      status: "success",
      serverId: "srv-b",
      appId: "app-b",
      commitBefore: null,
      commitAfter: null,
      duration: null,
      log: null,
      triggeredBy: "panel",
      createdAt: new Date(),
      app: { name: "my-app" },
      server: { name: "srv-b", userId: "user-b" },
    });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/deploy/deploy-1");
    expect(res.status).toBe(404);
  });

  it("admin can access any deploy regardless of server ownership", async () => {
    mDeploy.findUnique.mockResolvedValue({
      id: "deploy-1",
      status: "success",
      serverId: "srv-b",
      appId: "app-b",
      commitBefore: null,
      commitAfter: null,
      duration: null,
      log: null,
      triggeredBy: "panel",
      createdAt: new Date(),
      app: { name: "my-app" },
      server: { name: "srv-b", userId: "user-b" },
    });

    const res = await appFor({ userId: null, isAdmin: true }).request("/deploy/deploy-1");
    expect(res.status).toBe(200);
  });

  it("non-admin can access their own deploy", async () => {
    mDeploy.findUnique.mockResolvedValue({
      id: "deploy-1",
      status: "success",
      serverId: "srv-a",
      appId: "app-a",
      commitBefore: null,
      commitAfter: null,
      duration: null,
      log: null,
      triggeredBy: "panel",
      createdAt: new Date(),
      app: { name: "my-app" },
      server: { name: "my-server", userId: "user-a" },
    });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/deploy/deploy-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deploy: { id: string } };
    expect(body.deploy.id).toBe("deploy-1");
  });

  it("returns 404 when deploy does not exist", async () => {
    mDeploy.findUnique.mockResolvedValue(null);
    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/deploy/no-such-id");
    expect(res.status).toBe(404);
  });
});

describe("v1 GET /deploy/:id — steps normalisation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function deployWithLog(log: string | null) {
    return {
      id: "deploy-1",
      status: "failed",
      serverId: "srv-a",
      appId: "app-a",
      commitBefore: null,
      commitAfter: null,
      duration: null,
      log,
      triggeredBy: "panel",
      createdAt: new Date(),
      app: { name: "my-app" },
      server: { name: "my-server", userId: "user-a" },
    };
  }

  it("passes an array log straight through (stream-deploy step list)", async () => {
    mDeploy.findUnique.mockResolvedValue(deployWithLog(JSON.stringify([{ step: "clone" }, { step: "build" }])));

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/deploy/deploy-1");
    const body = (await res.json()) as { deploy: { steps: unknown } };
    expect(body.deploy.steps).toEqual([{ step: "clone" }, { step: "build" }]);
  });

  // Regression coverage: POST /rollback stores the raw relay result OBJECT
  // via JSON.stringify(result), not an array. Before this fix, `steps`
  // would silently hold that object at runtime despite its unknown[] type.
  it("wraps a non-array log (e.g. the rollback relay payload object) in a single-element array", async () => {
    mDeploy.findUnique.mockResolvedValue(
      deployWithLog(JSON.stringify({ blocked: true, preflight: { passed: false, checks: [] } })),
    );

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/deploy/deploy-1");
    const body = (await res.json()) as { deploy: { steps: unknown } };
    expect(body.deploy.steps).toEqual([{ blocked: true, preflight: { passed: false, checks: [] } }]);
  });

  it("wraps a JSON-encoded string log in a single-element array", async () => {
    mDeploy.findUnique.mockResolvedValue(deployWithLog(JSON.stringify("blocked by preflight")));

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/deploy/deploy-1");
    const body = (await res.json()) as { deploy: { steps: unknown } };
    expect(body.deploy.steps).toEqual(["blocked by preflight"]);
  });

  it("falls back to an empty array for a non-JSON log (e.g. 'Relay returned invalid JSON')", async () => {
    mDeploy.findUnique.mockResolvedValue(deployWithLog("Relay returned invalid JSON"));

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/deploy/deploy-1");
    const body = (await res.json()) as { deploy: { steps: unknown } };
    expect(body.deploy.steps).toEqual([]);
  });
});

// ── POST /rollback ────────────────────────────────────────────────────────────

describe("v1 POST /rollback — owned server flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("owned server: deploy.create called and relayRequest invoked with rollback path", async () => {
    const deployRecord = { id: "rollback-1", status: "running", serverId: "srv-a", appId: "app-a" };
    mServer.findFirst.mockResolvedValue(ownedServer);
    mApp.findUnique.mockResolvedValue(appRecord);
    mDeploy.create.mockResolvedValue(deployRecord);
    mDeploy.update.mockResolvedValue({});
    vi.mocked(relayRequest).mockResolvedValue({ success: true, commitBefore: "abc", commitAfter: "def" });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "my-server", app: "my-app", to_commit: "abc123" }),
    });

    expect(res.status).toBe(202);
    expect(mDeploy.create).toHaveBeenCalledOnce();
    const createData = mDeploy.create.mock.calls[0][0].data;
    expect(createData.status).toBe("running");

    // Flush the fire-and-forget IIFE so relayRequest has a chance to run
    await new Promise((r) => setTimeout(r, 0));

    expect(relayRequest).toHaveBeenCalledOnce();
    const relayArg = vi.mocked(relayRequest).mock.calls[0][0];
    expect(relayArg.path).toBe("/api/apps/my-app/rollback");
  });

  it("non-owned server: 404, no deploy created", async () => {
    mServer.findFirst.mockResolvedValue({ ...ownedServer, userId: "user-b" });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "srv-b", app: "my-app" }),
    });

    expect(res.status).toBe(404);
    expect(mDeploy.create).not.toHaveBeenCalled();
    expect(relayRequest).not.toHaveBeenCalled();
  });
});

// agent-relay nests the payload under `result` only when the rollback was
// blocked by preflight (mirrors apps.ts's rollback route and
// backend/tests/apps-rollback-route.test.ts); a completed attempt spreads
// success/commits at the top level instead. These tests pin that v1.ts
// reads BOTH shapes correctly.
describe("v1 POST /rollback: agent-relay result shape", () => {
  const deployRecord = { id: "rollback-1", status: "running", serverId: "srv-a", appId: "app-a" };

  beforeEach(() => {
    vi.clearAllMocks();
    mServer.findFirst.mockResolvedValue(ownedServer);
    mApp.findUnique.mockResolvedValue(appRecord);
    mDeploy.create.mockResolvedValue(deployRecord);
    mDeploy.update.mockResolvedValue({});
  });

  it("blocked by preflight: nested `result` is unwrapped, row is failed with the nested commits preserved, and the raw (still-nested) body is stored in log", async () => {
    const raw = {
      result: {
        success: false,
        blocked: true,
        preflight: { passed: false, checks: [] },
        commitBefore: "abc123",
        commitAfter: "abc123",
      },
    };
    vi.mocked(relayRequest).mockResolvedValue(raw);

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "my-server", app: "my-app" }),
    });

    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 0));

    expect(mDeploy.update).toHaveBeenCalledTimes(1);
    const updateData = mDeploy.update.mock.calls[0][0].data;
    expect(updateData.status).toBe("failed");
    expect(updateData.commitBefore).toBe("abc123");
    expect(updateData.commitAfter).toBe("abc123");
    expect(JSON.parse(updateData.log)).toEqual(raw);
  });

  it("positive case: flat top-level success shape marks the row rolled_back", async () => {
    vi.mocked(relayRequest).mockResolvedValue({ success: true, commitBefore: "abc", commitAfter: "def" });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "my-server", app: "my-app" }),
    });

    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 0));

    const updateData = mDeploy.update.mock.calls[0][0].data;
    expect(updateData.status).toBe("rolled_back");
    expect(updateData.commitBefore).toBe("abc");
    expect(updateData.commitAfter).toBe("def");
  });
});

// The real reachable failure path: agent-relay answers a non-preflight
// rollback failure with HTTP 4xx `{ error }`, which relayRequest() turns
// into a thrown RelayError: it never reaches the try block's flat-shape
// branch above. Before this fix, every RelayError (regardless of status)
// was routed to recoverBrokenDeploy, whose post-deploy health probe can't
// distinguish "rollback never ran, app still healthy from the prior
// deploy" from "rollback succeeded", a real, already-answered failure
// could end up recorded as a green success row. Modelled on
// backend/tests/apps-rollback-route.test.ts's twin describe block.
describe("v1 POST /rollback: RelayError from the relay call itself", () => {
  const deployRecord = { id: "rollback-1", status: "running", serverId: "srv-a", appId: "app-a" };

  beforeEach(() => {
    vi.clearAllMocks();
    mServer.findFirst.mockResolvedValue(ownedServer);
    mApp.findUnique.mockResolvedValue(appRecord);
    mDeploy.create.mockResolvedValue(deployRecord);
    mDeploy.update.mockResolvedValue({});
  });

  it("4xx RelayError: deploy row is marked failed directly with the relay's message, and recoverBrokenDeploy is NOT invoked", async () => {
    vi.mocked(relayRequest).mockRejectedValue(
      new RelayError('Relay error (400): {"error":"no previous deploy to roll back to"}', 400),
    );

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "my-server", app: "my-app" }),
    });

    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 0));

    expect(mDeploy.update).toHaveBeenCalledTimes(1);
    const updateData = mDeploy.update.mock.calls[0][0].data;
    expect(updateData.status).toBe("failed");
    expect(updateData.log).toContain("no previous deploy to roll back to");
    // `log` is a JSON-encoded single-element array, not the bare
    // err.message string, so it survives GET /deploy/:id's steps
    // normalisation below instead of falling through JSON.parse's catch.
    expect(JSON.parse(updateData.log)).toEqual([
      { error: 'Relay error (400): {"error":"no previous deploy to roll back to"}' },
    ]);

    expect(recoverBrokenDeploy).not.toHaveBeenCalled();
  });

  // Regression coverage: before this fix, the 4xx catch branch stored the
  // bare `err.message` string in `log`. GET /deploy/:id's steps
  // normalisation (backend/src/routes/v1.ts) only wraps a JSON-decodable
  // value; a plain, non-JSON string falls through its JSON.parse catch and
  // comes back as `steps: []`, so the failure reason the relay actually
  // gave was invisible to the MCP caller reading the deploy back. This
  // test round-trips the log this handler writes through the real GET
  // /deploy/:id normalisation and asserts the error is visible in steps.
  it("4xx RelayError: the stored log round-trips through GET /deploy/:id as a visible error step, not an empty array", async () => {
    vi.mocked(relayRequest).mockRejectedValue(
      new RelayError('Relay error (400): {"error":"no previous deploy to roll back to"}', 400),
    );

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "my-server", app: "my-app" }),
    });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 0));

    const updateData = mDeploy.update.mock.calls[0][0].data;

    mDeploy.findUnique.mockResolvedValue({
      id: "rollback-1",
      status: updateData.status,
      serverId: "srv-a",
      appId: "app-a",
      commitBefore: null,
      commitAfter: null,
      duration: null,
      log: updateData.log,
      triggeredBy: "panel",
      createdAt: new Date(),
      app: { name: "my-app" },
      server: { name: "my-server", userId: "user-a" },
    });

    const getRes = await appFor({ userId: "user-a", isAdmin: false }).request("/deploy/rollback-1");
    const body = (await getRes.json()) as { deploy: { steps: unknown } };
    expect(body.deploy.steps).toEqual([
      { error: expect.stringContaining("no previous deploy to roll back to") },
    ]);
  });

  it("5xx RelayError: still routed through recoverBrokenDeploy, not marked failed directly", async () => {
    vi.mocked(relayRequest).mockRejectedValue(new RelayError("Relay error (500): boom", 500));

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "my-server", app: "my-app" }),
    });

    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 0));

    expect(recoverBrokenDeploy).toHaveBeenCalledTimes(1);
    expect(mDeploy.update).not.toHaveBeenCalled();
  });
});

// This route drives the deploy record itself (relayRequest, then a direct
// prisma.deploy.update) instead of going through streamDeploy, so its id
// used to never enter the active-deploy registry: the periodic stuck-sweep
// (recoverStuckDeploys, startup.ts) could finalize a rollback that was
// still genuinely in flight once it aged past the 2-minute threshold. See
// deploy-panel#130.
describe("v1 POST /rollback: active-deploy registration", () => {
  const deployRecord = { id: "rollback-guard-1", status: "running", serverId: "srv-a", appId: "app-a" };

  beforeEach(() => {
    vi.clearAllMocks();
    clearActiveDeploys();
    mServer.findFirst.mockResolvedValue(ownedServer);
    mApp.findUnique.mockResolvedValue(appRecord);
    mDeploy.create.mockResolvedValue(deployRecord);
    mDeploy.update.mockResolvedValue({});
    mDeploy.updateMany.mockResolvedValue({ count: 1 });
    mDeploy.findFirst.mockResolvedValue(null);
  });

  it("registers the deploy id while relayRequest is in flight, and a concurrent stuck-sweep pass does not finalize it", async () => {
    let releaseRelay!: (v: unknown) => void;
    vi.mocked(relayRequest).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRelay = resolve;
        }),
    );

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "my-server", app: "my-app" }),
    });
    expect(res.status).toBe(202);

    await vi.waitFor(() => expect(relayRequest).toHaveBeenCalledOnce());
    expect(isActiveDeploy("rollback-guard-1")).toBe(true);

    // A concurrent stuck-sweep pass, run while the rollback is still
    // in-flight: simulate the real `notIn` filter recoverStuckDeploys
    // builds so the excluded id never even reaches the finalize step.
    mDeploy.findMany.mockImplementation(async (args: any) => {
      const excluded: string[] = args.where.id?.notIn ?? [];
      const candidate = {
        id: "rollback-guard-1",
        appId: "app-a",
        createdAt: new Date(0),
        log: null,
        app: { name: "my-app" },
        server: { id: "srv-a", relayUrl: null, relayToken: null },
      };
      return excluded.includes(candidate.id) ? [] : [candidate];
    });

    await recoverStuckDeploys();

    expect(mDeploy.updateMany).not.toHaveBeenCalled();

    releaseRelay({ success: true, commitBefore: "a", commitAfter: "b" });
    await new Promise((r) => setTimeout(r, 0));

    expect(isActiveDeploy("rollback-guard-1")).toBe(false);
  });

  // Pins the actual hand-off HIGH-1 added: recoverBrokenDeploy polls health
  // for up to ~60s after this handler has already returned its 202
  // response, so the deploy id must stay registered for that whole window.
  // The route now has NO `recovering` flag and a plain unconditional
  // try/finally (registerActiveDeploy at the top, releaseActiveDeploy in
  // finally): that is only safe because registration is refcounted AND
  // recoverBrokenDeploy holds its own independent registration on the same
  // id for the duration of its run. The mock below simulates that real
  // contract (registers when invoked, releases when its work settles)
  // rather than being a bare stub, since stubbing recoverBrokenDeploy away
  // here would otherwise erase the very overlap this test exists to pin. A
  // mutant that removes the route's own registerActiveDeploy at the top
  // (relying solely on recoverBrokenDeploy's hold) would surface in the
  // FIRST test in this describe block instead, whose success path has no
  // recoverBrokenDeploy hand-off to cover for it. recoverBrokenDeploy's own
  // self-registration is pinned separately, with the REAL function, in
  // deploy-recovery.test.ts's "self-registration" and "nested
  // register/release" tests.
  it("keeps the deploy id registered while recoverBrokenDeploy is still pending after a non-4xx error hand-off", async () => {
    vi.mocked(relayRequest).mockRejectedValue(new RelayError("Relay error (500): boom", 500));

    let settleRecover!: () => void;
    const controlled = new Promise<void>((resolve) => {
      settleRecover = resolve;
    });
    vi.mocked(recoverBrokenDeploy).mockImplementation((deployId: string) => {
      registerActiveDeploy(deployId);
      return controlled.then(() => releaseActiveDeploy(deployId));
    });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "my-server", app: "my-app" }),
    });
    expect(res.status).toBe(202);

    await vi.waitFor(() => expect(recoverBrokenDeploy).toHaveBeenCalledTimes(1));

    // The 202 response (and the background task's hand-off) has already
    // happened, and the route's own finally has released its own hold, but
    // recoverBrokenDeploy's own registration has not settled: the id must
    // still be registered.
    expect(isActiveDeploy("rollback-guard-1")).toBe(true);

    settleRecover();
    await controlled;
  });
});

// The background task's `recoverBrokenDeploy(...)` call is fire-and-forget
// (see the comment above the call site in v1.ts): the surrounding IIFE's
// own .catch does NOT cover it, since the call is neither awaited nor
// returned. recoverBrokenDeploy's internal prisma calls already each carry
// a trailing .catch, but a throw before any of them (e.g. verifyDeployHealth
// itself rejecting) used to become a genuinely separate unhandled rejection.
describe("v1 POST /rollback: recoverBrokenDeploy rejection is caught, not left unhandled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearActiveDeploys();
    mServer.findFirst.mockResolvedValue(ownedServer);
    mApp.findUnique.mockResolvedValue(appRecord);
    mDeploy.create.mockResolvedValue({ id: "guard-1", status: "running", serverId: "srv-a", appId: "app-a" });
    mDeploy.update.mockResolvedValue({});
  });

  it("logs and swallows a recoverBrokenDeploy rejection via its own .catch, instead of letting it propagate unhandled", async () => {
    vi.mocked(relayRequest).mockRejectedValue(new RelayError("Relay error (500): boom", 500));

    let rejectRecover!: (err: Error) => void;
    const controlled = new Promise<void>((_resolve, reject) => {
      rejectRecover = reject;
    });
    vi.mocked(recoverBrokenDeploy).mockReturnValue(controlled);

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await appFor({ userId: "user-a", isAdmin: false }).request("/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "my-server", app: "my-app" }),
    });
    expect(res.status).toBe(202);

    await vi.waitFor(() => expect(recoverBrokenDeploy).toHaveBeenCalledTimes(1));

    rejectRecover(new Error("verifyDeployHealth exploded"));
    // Give the .catch handler's microtask a turn to run. If the call site
    // has no .catch chained (the mutant this test exists to catch), this
    // rejection is left with no handler attached in this same synchronous
    // window, which is exactly what makes Node treat it as unhandled.
    await new Promise((r) => setTimeout(r, 0));

    const logged = consoleErrorSpy.mock.calls.some((args) =>
      String(args[0]).includes("[stuck-sweep] recoverBrokenDeploy failed"),
    );
    expect(logged).toBe(true);

    consoleErrorSpy.mockRestore();
  });
});
