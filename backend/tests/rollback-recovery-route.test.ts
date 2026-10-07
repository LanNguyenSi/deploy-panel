import { describe, expect, it, vi, beforeEach } from "vitest";

// End to end through the apps rollback route with the REAL recoverBrokenDeploy
// and target check (only the relay, the database and the health gate are
// faked): the UI button and the MCP client send no to_commit, so the default
// path of a connection-lost rollback must recover to success on an id-capable
// relay once the relay shows the id-matched rollback moved the repo, and must
// still end interrupted when it shows nothing.

vi.mock("../src/lib/relay.js", () => ({
  relayRequest: vi.fn(),
  RelayError: class RelayError extends Error {
    status: number;
    body?: unknown;
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

const ROW_START = new Date("2026-10-06T10:00:00.000Z");

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    app: {
      upsert: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue({ liveUrl: null }),
    },
    deploy: {
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("../src/lib/post-deploy-gate.js", () => ({
  verifyDeployHealth: vi.fn().mockResolvedValue({ healthy: true }),
}));

vi.mock("../src/lib/audit.js", () => ({
  audit: vi.fn(),
  getActor: vi.fn(() => "panel"),
  getActorUserId: vi.fn(() => "user-a"),
}));

vi.mock("../src/lib/stream-deploy.js", () => ({ streamDeploy: vi.fn() }));

import { Hono } from "hono";
import { relayRequest, RelayError } from "../src/lib/relay.js";
import { prisma } from "../src/lib/prisma.js";
import { appsRouter } from "../src/routes/apps.js";
import { clearActiveDeploys } from "../src/lib/deploy-recovery.js";

const mRelay = relayRequest as unknown as ReturnType<typeof vi.fn>;
const mDeployUpdate = prisma.deploy.update as unknown as ReturnType<typeof vi.fn>;
const mAppUpdate = prisma.app.update as unknown as ReturnType<typeof vi.fn>;

const HEAD = "abc1234";
const FULL = "abc1234" + "d".repeat(33);

function app() {
  const a = new Hono();
  a.route("/servers/:serverId/apps", appsRouter as unknown as Hono);
  return a;
}

/** The relay: POST rollback drops the connection (5xx), /health and the app lookup answer. */
function relayDropsRollbackThen(version: string, recentDeploys: Array<Record<string, unknown>>, commit = HEAD) {
  mRelay.mockImplementation(async ({ path, method }: { path: string; method?: string }) => {
    if (method === "POST") throw new RelayError("Relay error (502): socket hang up", 502);
    if (path === "/health") return { status: "ok", version };
    return { app: { name: "my-app", commit, containers: "[]", recentDeploys } };
  });
}

const rollbackEntry = (over: Record<string, unknown> = {}) => ({
  status: "success",
  commitBefore: "f".repeat(40),
  commitAfter: FULL,
  createdAt: new Date(ROW_START.getTime() + 20_000).toISOString(),
  durationMs: 0,
  triggeredBy: "api",
  deployId: "d-rb",
  ...over,
});

async function postRollbackWithoutCommit() {
  const res = await app().request("/servers/srv-a/apps/my-app/rollback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(502);
  // Recovery is fire and forget: wait for it to finalize the row.
  await vi.waitFor(() => expect(mDeployUpdate).toHaveBeenCalled());
  return mDeployUpdate.mock.calls[mDeployUpdate.mock.calls.length - 1][0] as {
    data: { status: string };
  };
}

describe("rollback route with to_commit omitted: connection-lost recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearActiveDeploys();
    (prisma.app.upsert as any).mockResolvedValue({ id: "app-a", name: "my-app" });
    (prisma.deploy.create as any).mockResolvedValue({ id: "d-rb", status: "running" });
    (prisma.deploy.findUnique as any).mockResolvedValue({ log: null, createdAt: ROW_START });
    (prisma.deploy.findFirst as any).mockResolvedValue(null);
    mDeployUpdate.mockResolvedValue({});
    mAppUpdate.mockResolvedValue({});
  });

  it("id-capable relay: the id-matched rollback entry moved the repo to HEAD -> success", async () => {
    relayDropsRollbackThen("0.6.0", [rollbackEntry()]);

    const update = await postRollbackWithoutCommit();

    expect(update.data.status).toBe("success");
    expect(mAppUpdate.mock.calls.at(-1)![0].data.lastDeployAt).toBeInstanceOf(Date);
  });

  it("id-capable relay, the rollback left no entry (still healthy on the old version) -> interrupted, lastDeployAt unchanged", async () => {
    relayDropsRollbackThen("0.6.0", [rollbackEntry({ deployId: "older", createdAt: new Date(ROW_START.getTime() - 3_600_000).toISOString() })]);

    const update = await postRollbackWithoutCommit();

    expect(update.data.status).toBe("interrupted");
    expect(mAppUpdate.mock.calls.at(-1)![0].data).toEqual({ status: "healthy" });
  });

  it("relay that is not id-capable: an omitted to_commit is unprovable -> interrupted", async () => {
    relayDropsRollbackThen("0.5.0", [rollbackEntry({ deployId: undefined })]);

    const update = await postRollbackWithoutCommit();

    expect(update.data.status).toBe("interrupted");
  });
});
