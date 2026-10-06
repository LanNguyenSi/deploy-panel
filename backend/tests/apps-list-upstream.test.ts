import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// GET /api/servers/:serverId/apps merges the relay's per-app upstream info
// (deployed commit vs remote branch head) into each app row.

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

import { prisma } from "../src/lib/prisma.js";
import { relayRequest } from "../src/lib/relay.js";
import { appsRouter } from "../src/routes/apps.js";

const mFindMany = (prisma.app as any).findMany as ReturnType<typeof vi.fn>;
const mRelay = relayRequest as unknown as ReturnType<typeof vi.fn>;

const A = "a".repeat(40);
const B = "b".repeat(40);

function list() {
  const a = new Hono();
  a.route("/servers/:serverId/apps", appsRouter as unknown as Hono);
  return a.request("/servers/srv-a/apps");
}

beforeEach(() => {
  vi.clearAllMocks();
  mFindMany.mockResolvedValue([
    { id: "1", name: "alpha", repoUrl: null },
    { id: "2", name: "beta", repoUrl: null },
  ]);
});

describe("GET /servers/:serverId/apps upstream", () => {
  it("attaches relay upstream per app and marks an app the relay omits unknown", async () => {
    mRelay.mockResolvedValue({
      apps: [
        {
          name: "alpha",
          upstream: { branch: "main", deployedCommit: A, remoteHead: B, checkedAt: "2026-10-06T10:00:00Z", state: "behind" },
        },
        { name: "beta" },
      ],
    });
    const body = await (await list()).json();
    expect(mRelay).toHaveBeenCalledWith(expect.objectContaining({ serverId: "srv-a", path: "/api/apps" }));
    expect(body.apps[0].upstream).toMatchObject({ state: "behind", deployedCommit: A, remoteHead: B });
    expect(body.apps[1].upstream).toMatchObject({ state: "unknown", reason: "relay does not report upstream" });
  });

  it("still lists apps (all unknown) when the relay is unreachable", async () => {
    mRelay.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await list();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apps).toHaveLength(2);
    for (const a of body.apps) expect(a.upstream).toMatchObject({ state: "unknown", reason: "relay unreachable" });
  });

  it("does not call the relay for a server without apps", async () => {
    mFindMany.mockResolvedValue([]);
    const body = await (await list()).json();
    expect(body.apps).toEqual([]);
    expect(mRelay).not.toHaveBeenCalled();
  });
});
