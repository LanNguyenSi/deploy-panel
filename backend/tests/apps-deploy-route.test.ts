import { describe, expect, it, vi, beforeEach } from "vitest";

// POST /:name/deploy and POST /bulk-deploy (apps.ts) both fire streamDeploy
// (fire-and-forget) to actually drive the deploy over the relay. Every
// existing apps-router test vi.mocks streamDeploy but none of them ever
// asserted it was actually CALLED; a route that silently dropped the call
// (e.g. lost in a refactor) would still 202 with a "running" deploy record
// and pass every test in this suite. These tests close that gap, mirroring
// the pattern already used for the delegation assertion on v1's /deploy
// route (tests/v1-api.test.ts, ~line 406) and the scheduler's stuck-sweep
// delegation (tests/scheduler.test.ts, ~line 120).

vi.mock("../src/lib/ownership.js", () => ({
  getActorContext: vi.fn(() => ({ userId: "user-a", isAdmin: false })),
  findOwnedServer: vi.fn(async () => ({ id: "srv-a", userId: "user-a" })),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    app: {
      upsert: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    deploy: {
      create: vi.fn(),
    },
    server: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("../src/lib/audit.js", () => ({
  audit: vi.fn(),
  getActor: vi.fn(() => "panel"),
  getActorUserId: vi.fn(() => "user-a"),
}));

vi.mock("../src/lib/stream-deploy.js", () => ({ streamDeploy: vi.fn() }));
vi.mock("../src/lib/deploy-recovery.js", () => ({
  recoverBrokenDeploy: vi.fn().mockResolvedValue(undefined),
  registerActiveDeploy: vi.fn(),
  releaseActiveDeploy: vi.fn(),
}));

import { prisma } from "../src/lib/prisma.js";
import { streamDeploy } from "../src/lib/stream-deploy.js";
import { appsRouter } from "../src/routes/apps.js";
import { getActorContext } from "../src/lib/ownership.js";
import { Hono } from "hono";

const mAppUpsert = prisma.app.upsert as unknown as ReturnType<typeof vi.fn>;
const mAppUpdate = prisma.app.update as unknown as ReturnType<typeof vi.fn>;
const mDeployCreate = prisma.deploy.create as unknown as ReturnType<typeof vi.fn>;
const mServerFindUnique = prisma.server.findUnique as unknown as ReturnType<typeof vi.fn>;
const mStreamDeploy = streamDeploy as unknown as ReturnType<typeof vi.fn>;

function app() {
  const a = new Hono();
  a.route("/servers/:serverId/apps", appsRouter as unknown as Hono);
  return a;
}

describe("apps router: streamDeploy delegation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mAppUpsert.mockResolvedValue({ id: "app-a", name: "my-app" });
    mAppUpdate.mockResolvedValue({});
    mServerFindUnique.mockResolvedValue({
      id: "srv-a",
      relayUrl: "http://relay.example",
      relayToken: "tok",
    });
  });

  it("POST /:name/deploy calls streamDeploy exactly once", async () => {
    mDeployCreate.mockResolvedValue({ id: "deploy-1", status: "running" });

    const res = await app().request("/servers/srv-a/apps/my-app/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(202);
    expect(mStreamDeploy).toHaveBeenCalledOnce();
    expect(mStreamDeploy).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "srv-a",
        deployId: "deploy-1",
        appId: "app-a",
        appName: "my-app",
        relayUrl: "http://relay.example",
      }),
    );
    const body = (await res.json()) as { deploy: { id: string; status: string } };
    expect(body.deploy.status).toBe("running");
  });

  it("POST /:name/deploy hands streamDeploy the app status from before the dispatch (so a blocked deploy can restore it)", async () => {
    mAppUpsert.mockResolvedValue({ id: "app-a", name: "my-app", status: "healthy" });
    mDeployCreate.mockResolvedValue({ id: "deploy-1", status: "running" });

    await app().request("/servers/srv-a/apps/my-app/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(mAppUpdate).toHaveBeenCalledWith({ where: { id: "app-a" }, data: { status: "deploying" } });
    expect(mStreamDeploy).toHaveBeenCalledWith(expect.objectContaining({ previousStatus: "healthy" }));
  });

  it("POST /bulk-deploy hands each streamDeploy the app status from before the dispatch and keeps force=false", async () => {
    mAppUpsert.mockResolvedValue({ id: "app-a", name: "my-app", status: "unhealthy" });
    mDeployCreate.mockResolvedValue({ id: "deploy-a", status: "running" });

    await app().request("/servers/srv-a/apps/bulk-deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apps: ["app-1"] }),
    });

    expect(mStreamDeploy).toHaveBeenCalledWith(
      expect.objectContaining({ previousStatus: "unhealthy", body: { force: false } }),
    );
  });

  describe("connect-time guard flag", () => {
    const post = (path: string, body: unknown) =>
      app().request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    beforeEach(() => {
      mDeployCreate.mockResolvedValue({ id: "deploy-1", status: "running" });
      mServerFindUnique.mockResolvedValue({
        id: "srv-a",
        userId: "user-a",
        relayUrl: "http://relay.example",
        relayToken: "tok",
      });
    });

    it.each([
      ["POST /:name/deploy", "/servers/srv-a/apps/my-app/deploy", {}],
      ["POST /bulk-deploy", "/servers/srv-a/apps/bulk-deploy", { apps: ["app-1"] }],
    ])("%s: an owned row deployed by its non-admin owner asks for the guard", async (_l, path, body) => {
      await post(path, body);
      expect(mStreamDeploy).toHaveBeenCalledWith(expect.objectContaining({ connectGuard: true }));
    });

    it.each([
      ["POST /:name/deploy", "/servers/srv-a/apps/my-app/deploy", {}],
      ["POST /bulk-deploy", "/servers/srv-a/apps/bulk-deploy", { apps: ["app-1"] }],
    ])("%s: an admin acting on the same row does not", async (_l, path, body) => {
      vi.mocked(getActorContext).mockReturnValue({ userId: null, isAdmin: true });
      await post(path, body);
      expect(mStreamDeploy).toHaveBeenCalledWith(expect.objectContaining({ connectGuard: false }));
      vi.mocked(getActorContext).mockReturnValue({ userId: "user-a", isAdmin: false });
    });
  });

  it("POST /bulk-deploy calls streamDeploy exactly once per app", async () => {
    mDeployCreate
      .mockResolvedValueOnce({ id: "deploy-a", status: "running" })
      .mockResolvedValueOnce({ id: "deploy-b", status: "running" });

    const res = await app().request("/servers/srv-a/apps/bulk-deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apps: ["app-1", "app-2"] }),
    });

    expect(res.status).toBe(202);
    expect(mStreamDeploy).toHaveBeenCalledTimes(2);
    const deployIds = mStreamDeploy.mock.calls.map((c) => (c[0] as { deployId: string }).deployId);
    expect(deployIds.sort()).toEqual(["deploy-a", "deploy-b"]);
    for (const [arg] of mStreamDeploy.mock.calls) {
      expect(arg).toEqual(
        expect.objectContaining({ serverId: "srv-a", relayUrl: "http://relay.example" }),
      );
    }
  });
});

// The deploy route is the one :name trigger that used to create the App row
// first and only then fail: findOrCreateApp's pattern refusal threw a plain
// Error, app.onError answered 500, and a name the local pattern refuses (a
// dot, a traversal shape) still left a row's worth of work behind it. It now
// refuses with the same 400 invalid_app_name the sibling :name routes
// answer, BEFORE findOrCreateApp or any Deploy row.
describe("apps POST /:name/deploy: refused app name answers 400 before any row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mAppUpsert.mockResolvedValue({ id: "app-a", name: "my-app" });
    mDeployCreate.mockResolvedValue({ id: "deploy-1", status: "running" });
    mServerFindUnique.mockResolvedValue({ id: "srv-a", relayUrl: "http://relay.example", relayToken: "tok" });
  });

  // The empty name and a lone `..` segment are not reachable here: Hono will
  // not match an empty :name segment, and the URL parser collapses a `..`
  // path segment (even percent-encoded, `%2E%2E` -> `..`) before routing, so
  // that request 404s on a different path. The traversal shapes that DO
  // survive parsing (a percent-encoded `%2E%2E%2F...` stays one segment and
  // decodes into the param) and dotted names are what this route's own
  // pattern refuses. The empty/`..` shapes are pinned directly against
  // findOrCreateApp in apps-invalid-app-name-backstop.test.ts; the v1
  // route's falsy check covers the empty string there.
  it.each([
    ["my.app", "my.app"],
    ["../../etc/passwd", "%2E%2E%2F%2E%2E%2Fetc%2Fpasswd"],
    ["leading-dot segment", ".hidden"],
  ])("POST /%s/deploy: 400 invalid_app_name, no App upsert, no Deploy row, no streamDeploy", async (_label, encoded) => {
    const res = await app().request(`/servers/srv-a/apps/${encoded}/deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_app_name");
    expect(mAppUpsert).not.toHaveBeenCalled();
    expect(mDeployCreate).not.toHaveBeenCalled();
    expect(mStreamDeploy).not.toHaveBeenCalled();
  });
});
