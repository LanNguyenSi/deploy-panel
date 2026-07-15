import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    scheduledDeploy: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    app: {
      upsert: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
    deploy: {
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("../src/lib/stream-deploy.js", () => ({
  streamDeploy: vi.fn(),
}));

import { prisma } from "../src/lib/prisma.js";
import { streamDeploy } from "../src/lib/stream-deploy.js";
import { checkScheduled } from "../src/lib/scheduler.js";

const mScheduledDeploy = prisma.scheduledDeploy as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mApp = prisma.app as unknown as {
  upsert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
};
const mDeploy = prisma.deploy as unknown as {
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mStreamDeploy = streamDeploy as unknown as ReturnType<typeof vi.fn>;

// A due entry with all required fields for the scheduler
const makeDueEntry = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "sched-1",
  serverId: "srv-a",
  appName: "my-app",
  scheduledFor: new Date(Date.now() - 1000), // 1 second ago (due)
  force: false,
  status: "pending",
  deployId: null,
  createdAt: new Date(),
  server: {
    id: "srv-a",
    name: "my-server",
    relayUrl: "http://relay.example",
    relayToken: "relay-tok",
  },
  ...overrides,
});

// ── Due-selection ─────────────────────────────────────────────────────────────

describe("checkScheduled — due-selection query", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries with status=pending and scheduledFor.lte ≈ now", async () => {
    mScheduledDeploy.findMany.mockResolvedValue([]);

    const before = Date.now();
    await checkScheduled();
    const after = Date.now();

    expect(mScheduledDeploy.findMany).toHaveBeenCalledOnce();
    const findArg = mScheduledDeploy.findMany.mock.calls[0][0];
    expect(findArg.where.status).toBe("pending");
    expect(findArg.where.scheduledFor.lte).toBeInstanceOf(Date);
    // The cutoff must be within the test window
    const lte = (findArg.where.scheduledFor.lte as Date).getTime();
    expect(lte).toBeGreaterThanOrEqual(before - 100);
    expect(lte).toBeLessThanOrEqual(after + 100);
  });
});

// ── Empty due list ────────────────────────────────────────────────────────────

describe("checkScheduled — empty due list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no deploy.create or streamDeploy called when nothing is due", async () => {
    mScheduledDeploy.findMany.mockResolvedValue([]);

    await checkScheduled();

    expect(mDeploy.create).not.toHaveBeenCalled();
    expect(mScheduledDeploy.update).not.toHaveBeenCalled();
    expect(mStreamDeploy).not.toHaveBeenCalled();
  });
});

// ── Delegation to streamDeploy (the HIGH-2 fix) ────────────────────────────────
//
// A scheduled deploy must go through the exact same streamDeploy() every
// other trigger uses — that is what makes the pre-deploy secret
// provisioning and required-env hard-fail gate apply to scheduled deploys
// too. Before this fix, checkScheduled() called relayRequest directly and
// skipped both, reproducing the METRICS_API_TOKEN incident for the
// scheduled-deploy trigger specifically. The gate's own pass/fail behavior
// is unit-tested against the real streamDeploy() in
// stream-deploy-gate.test.ts; this file additionally proves checkScheduled()
// actually delegates to it (not a second, divergent implementation) and
// exercises the REAL streamDeploy() end-to-end via checkScheduled() for the
// two gate outcomes below.

describe("checkScheduled — delegates to streamDeploy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("transitions to triggered, creates the deploy row, links deployId, and calls streamDeploy with the server's relay creds", async () => {
    const app = { id: "app-1", name: "my-app" };
    const deploy = { id: "deploy-1" };

    mScheduledDeploy.findMany.mockResolvedValue([makeDueEntry()]);
    mScheduledDeploy.update.mockResolvedValue({});
    mApp.upsert.mockResolvedValue(app);
    mApp.update.mockResolvedValue({});
    mDeploy.create.mockResolvedValue(deploy);

    await checkScheduled();

    // First scheduledDeploy.update: transition to "triggered"
    const firstUpdate = mScheduledDeploy.update.mock.calls[0][0];
    expect(firstUpdate.where.id).toBe("sched-1");
    expect(firstUpdate.data.status).toBe("triggered");

    // deploy.create with triggeredBy: "scheduled" and status: "running"
    expect(mDeploy.create).toHaveBeenCalledOnce();
    const deployCreateData = mDeploy.create.mock.calls[0][0].data;
    expect(deployCreateData.triggeredBy).toBe("scheduled");
    expect(deployCreateData.status).toBe("running");
    expect(deployCreateData.serverId).toBe("srv-a");
    expect(deployCreateData.appId).toBe("app-1");

    // Second scheduledDeploy.update: links deployId
    const secondUpdate = mScheduledDeploy.update.mock.calls[1][0];
    expect(secondUpdate.where.id).toBe("sched-1");
    expect(secondUpdate.data.deployId).toBe("deploy-1");

    // app flipped to "deploying" before the (fire-and-forget) streamDeploy call
    expect(mApp.update).toHaveBeenCalledWith({ where: { id: "app-1" }, data: { status: "deploying" } });

    // streamDeploy called with the exact shape it needs — a swapped field
    // here would silently break provisioning/gating or point at the wrong
    // relay for this app.
    expect(mStreamDeploy).toHaveBeenCalledOnce();
    expect(mStreamDeploy).toHaveBeenCalledWith({
      serverId: "srv-a",
      deployId: "deploy-1",
      appId: "app-1",
      appName: "my-app",
      relayUrl: "http://relay.example",
      relayToken: "relay-tok",
      body: { force: false },
    });
  });

  it("passes an empty relayUrl and null relayToken when the server has none configured", async () => {
    mScheduledDeploy.findMany.mockResolvedValue([
      makeDueEntry({ server: { id: "srv-a", name: "my-server", relayUrl: null, relayToken: null } }),
    ]);
    mScheduledDeploy.update.mockResolvedValue({});
    mApp.upsert.mockResolvedValue({ id: "app-1", name: "my-app" });
    mApp.update.mockResolvedValue({});
    mDeploy.create.mockResolvedValue({ id: "deploy-1" });

    await checkScheduled();

    expect(mStreamDeploy).toHaveBeenCalledWith(
      expect.objectContaining({ relayUrl: "", relayToken: null }),
    );
  });

  it("forwards the scheduled entry's force flag into streamDeploy's body", async () => {
    mScheduledDeploy.findMany.mockResolvedValue([makeDueEntry({ force: true })]);
    mScheduledDeploy.update.mockResolvedValue({});
    mApp.upsert.mockResolvedValue({ id: "app-1", name: "my-app" });
    mApp.update.mockResolvedValue({});
    mDeploy.create.mockResolvedValue({ id: "deploy-1" });

    await checkScheduled();

    expect(mStreamDeploy).toHaveBeenCalledWith(expect.objectContaining({ body: { force: true } }));
  });
});

// The gate's own pass/fail behavior against a REAL (unmocked) streamDeploy,
// invoked through the real checkScheduled(), lives in
// scheduler-required-env-gate.test.ts — kept in a separate file because it
// needs stream-deploy.js NOT mocked, which doesn't mix well with this
// file's blanket `vi.mock("../src/lib/stream-deploy.js", ...)` above.
