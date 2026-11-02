import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// The app list stays database-only (no relay call); the relay's per-app
// upstream info (deployed commit vs remote branch head) is served separately
// by GET /api/servers/:serverId/apps/upstream.

vi.mock("../src/lib/relay.js", () => ({
  relayRequest: vi.fn(),
  RelayError: class RelayError extends Error {
    status = 500;
  },
}));

vi.mock("../src/lib/ownership.js", () => ({
  getActorContext: vi.fn(() => ({ userId: "user-a", isAdmin: false })),
  findOwnedServer: vi.fn(async () => ({ id: "srv-a", userId: "user-a" })),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: { app: { findMany: vi.fn() }, deploy: { findFirst: vi.fn() } },
}));

vi.mock("../src/lib/audit.js", () => ({
  audit: vi.fn(),
  getActor: vi.fn(() => "panel"),
  getActorUserId: vi.fn(() => "user-a"),
}));
vi.mock("../src/lib/stream-deploy.js", () => ({ streamDeploy: vi.fn() }));
vi.mock("../src/lib/deploy-recovery.js", () => ({ recoverBrokenDeploy: vi.fn() }));

import { findOwnedServer } from "../src/lib/ownership.js";
import { prisma } from "../src/lib/prisma.js";
import { relayRequest } from "../src/lib/relay.js";
import { appsRouter } from "../src/routes/apps.js";

const mFindMany = (prisma.app as any).findMany as ReturnType<typeof vi.fn>;
const mDeployFirst = (prisma.deploy as any).findFirst as ReturnType<typeof vi.fn>;
const mRelay = relayRequest as unknown as ReturnType<typeof vi.fn>;

const A = "a".repeat(40);
const B = "b".repeat(40);

function get(path: string) {
  const a = new Hono();
  a.route("/servers/:serverId/apps", appsRouter as unknown as Hono);
  return a.request(`/servers/srv-a/apps${path}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mDeployFirst.mockResolvedValue(null);
  mFindMany.mockResolvedValue([
    { id: "1", name: "alpha", repoUrl: null },
    { id: "2", name: "beta", repoUrl: null },
  ]);
});

describe("GET /servers/:serverId/apps", () => {
  it("reads only the newest deploy of each app with one bounded query", async () => {
    await get("");
    expect(mDeployFirst).toHaveBeenCalledTimes(2);
    expect(mDeployFirst).toHaveBeenCalledWith({
      where: { appId: "1" },
      orderBy: { createdAt: "desc" },
      select: { status: true, log: true },
    });
    expect(mDeployFirst.mock.calls.map((c) => c[0].where.appId)).toEqual(["1", "2"]);
    // No nested include of deploys on the list query (Prisma would load them all).
    expect(mFindMany.mock.calls[0][0].include).not.toHaveProperty("deploys");
  });

  it("takes the outcome from the newest deploy, not an older rolled-back one", async () => {
    mDeployFirst.mockImplementation(async (args: any) =>
      args.orderBy.createdAt === "desc" ? { status: "success", log: "[]" } : { status: "failed", log: "[]" },
    );
    const body = await (await get("")).json();
    expect(body.apps.map((a: any) => a.lastDeployOutcome)).toEqual(["success", "success"]);
  });

  it("lists apps from the database without calling the relay", async () => {
    const res = await get("");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apps.map((a: any) => a.name)).toEqual(["alpha", "beta"]);
    expect(body.apps[0]).not.toHaveProperty("upstream");
    expect(mRelay).not.toHaveBeenCalled();
  });

  it("classifies the newest deploy per app as lastDeployOutcome and does not send the log", async () => {
    const steps = (health?: string) =>
      JSON.stringify([
        { name: "compose up", status: "failure", durationMs: 1 },
        ...(health ? [{ name: "rollback: health check", status: health, durationMs: 1 }] : []),
      ]);
    const newestByApp: Record<string, any> = {
      "1": { status: "failed", log: steps("success") },
      "2": { status: "failed", log: steps("failure") },
      "3": { status: "failed", log: steps() },
      "4": { status: "success", log: "[]" },
      "5": { status: "running", log: null },
      "6": null,
    };
    mFindMany.mockResolvedValue(
      ["rolled", "outage", "old-relay", "ok", "running", "never"].map((name, i) => ({ id: String(i + 1), name })),
    );
    mDeployFirst.mockImplementation(async (args: any) => newestByApp[args.where.appId]);
    const body = await (await get("")).json();
    const outcome = Object.fromEntries(body.apps.map((a: any) => [a.name, a.lastDeployOutcome]));
    expect(outcome).toEqual({
      rolled: "rolled_back_healthy",
      outage: "outage",
      "old-relay": "outage",
      ok: "success",
      running: null,
      never: null,
    });
    for (const a of body.apps) expect(a).not.toHaveProperty("deploys");
  });
});

describe("GET /servers/:serverId/apps/:name/deploys/:deployId", () => {
  const mFindFirst = (prisma.deploy as any).findFirst as ReturnType<typeof vi.fn>;
  const log = JSON.stringify([
    { name: "compose up", status: "failure", durationMs: 1 },
    { name: "rollback: health check", status: "success", durationMs: 1 },
  ]);

  it("adds the outcome to the polled deploy row", async () => {
    mFindFirst.mockResolvedValue({ id: "d1", status: "failed", log });
    const body = await (await get("/alpha/deploys/d1")).json();
    expect(body.deploy).toMatchObject({ id: "d1", status: "failed", outcome: "rolled_back_healthy" });
  });

  it("gives a running deploy no outcome", async () => {
    mFindFirst.mockResolvedValue({ id: "d1", status: "running", log: null });
    const body = await (await get("/alpha/deploys/d1")).json();
    expect(body.deploy.outcome).toBeNull();
  });
});

describe("GET /servers/:serverId/apps/upstream", () => {
  it("maps relay upstream per app name and marks an app the relay does not report unknown", async () => {
    mRelay.mockResolvedValue({
      apps: [
        {
          name: "alpha",
          configured: true,
          upstream: { branch: "main", deployedCommit: A, remoteHead: B, checkedAt: "2026-10-06T10:00:00Z", state: "behind" },
        },
        { name: "beta", configured: true },
      ],
    });
    const res = await get("/upstream");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mRelay).toHaveBeenCalledTimes(1);
    expect(mRelay).toHaveBeenCalledWith(expect.objectContaining({ serverId: "srv-a", path: "/api/apps", timeoutMs: 8000 }));
    expect(Object.keys(body.upstream).sort()).toEqual(["alpha", "beta"]);
    expect(body.upstream.alpha).toMatchObject({ state: "behind", deployedCommit: A, remoteHead: B });
    expect(body.upstream.beta).toMatchObject({ state: "unknown", reason: "relay does not report upstream" });
  });

  it("gives a distinct reason per relay listing shape", async () => {
    mRelay.mockResolvedValue({ apps: [{ name: "alpha", configured: true }] });
    let body = await (await get("/upstream")).json();
    expect(body.upstream.alpha.reason).toBe("relay does not report upstream");
    expect(body.upstream.beta.reason).toBe("relay does not list this app");

    mRelay.mockResolvedValue({ apps: [{ name: "alpha", configured: true }, { name: "beta", configured: false }] });
    body = await (await get("/upstream")).json();
    expect(body.upstream.beta.reason).toBe("app not configured on relay");

    mRelay.mockResolvedValue({});
    body = await (await get("/upstream")).json();
    expect(body.upstream.alpha.reason).toBe("relay listing unavailable");
  });

  it("still answers 200 (all unknown) when the relay is unreachable", async () => {
    mRelay.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await get("/upstream");
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const n of ["alpha", "beta"]) expect(body.upstream[n]).toMatchObject({ state: "unknown", reason: "relay unreachable" });
  });

  it("does not call the relay for a server without apps", async () => {
    mFindMany.mockResolvedValue([]);
    const body = await (await get("/upstream")).json();
    expect(body.upstream).toEqual({});
    expect(mRelay).not.toHaveBeenCalled();
  });

  it("applies the same ownership check as the list route", async () => {
    (findOwnedServer as any).mockResolvedValueOnce(null);
    const res = await get("/upstream");
    expect(res.status).toBe(404);
    expect(mRelay).not.toHaveBeenCalled();
  });
});
