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
    const body = (await res.json()) as { deploy: { id: string; status: string } };
    expect(body.deploy.status).toBe("running");
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
  });
});
