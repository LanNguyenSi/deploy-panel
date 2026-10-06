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
  prisma: { app: { findMany: vi.fn() } },
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
  mFindMany.mockResolvedValue([
    { id: "1", name: "alpha", repoUrl: null },
    { id: "2", name: "beta", repoUrl: null },
  ]);
});

describe("GET /servers/:serverId/apps", () => {
  it("lists apps from the database without calling the relay", async () => {
    const res = await get("");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apps.map((a: any) => a.name)).toEqual(["alpha", "beta"]);
    expect(body.apps[0]).not.toHaveProperty("upstream");
    expect(mRelay).not.toHaveBeenCalled();
  });
});

describe("GET /servers/:serverId/apps/upstream", () => {
  it("maps relay upstream per app name and marks an app the relay does not report unknown", async () => {
    mRelay.mockResolvedValue({
      apps: [
        {
          name: "alpha",
          upstream: { branch: "main", deployedCommit: A, remoteHead: B, checkedAt: "2026-10-06T10:00:00Z", state: "behind" },
        },
        { name: "beta" },
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

  it("gives a distinct reason for an app the relay does not list", async () => {
    mRelay.mockResolvedValue({ apps: [{ name: "alpha" }] });
    const body = await (await get("/upstream")).json();
    expect(body.upstream.beta).toMatchObject({ state: "unknown", reason: "app not configured on relay" });
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
