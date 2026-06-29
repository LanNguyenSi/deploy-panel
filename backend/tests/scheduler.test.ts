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
    },
    deploy: {
      create: vi.fn(),
      update: vi.fn(),
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

vi.mock("../src/lib/deploy-recovery.js", () => ({
  recoverBrokenDeploy: vi.fn(),
}));

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
import { relayRequest } from "../src/lib/relay.js";
import { recoverBrokenDeploy } from "../src/lib/deploy-recovery.js";
import { checkScheduled } from "../src/lib/scheduler.js";

const mScheduledDeploy = prisma.scheduledDeploy as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mApp = prisma.app as unknown as {
  upsert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mDeploy = prisma.deploy as unknown as {
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

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

  it("no deploy.create or scheduledDeploy.update called when nothing is due", async () => {
    mScheduledDeploy.findMany.mockResolvedValue([]);

    await checkScheduled();

    expect(mDeploy.create).not.toHaveBeenCalled();
    expect(mScheduledDeploy.update).not.toHaveBeenCalled();
    expect(relayRequest).not.toHaveBeenCalled();
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe("checkScheduled — happy path: one due entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("transitions to triggered, creates deploy, links deployId, and fires relay", async () => {
    const app = { id: "app-1", name: "my-app" };
    const deploy = { id: "deploy-1" };

    mScheduledDeploy.findMany.mockResolvedValue([makeDueEntry()]);
    mScheduledDeploy.update.mockResolvedValue({});
    mApp.upsert.mockResolvedValue(app);
    mApp.update.mockResolvedValue({});
    mDeploy.create.mockResolvedValue(deploy);
    mDeploy.update.mockResolvedValue({});
    vi.mocked(relayRequest).mockResolvedValue({
      success: true,
      commitBefore: "abc",
      commitAfter: "def",
      durationMs: 100,
      steps: [],
    });

    await checkScheduled();

    // --- Synchronously observable outcomes (before the IIFE flush) ---

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

    // --- Flush the fire-and-forget IIFE ---
    await new Promise((r) => setTimeout(r, 0));

    // relayRequest called with the correct deploy path
    expect(relayRequest).toHaveBeenCalledOnce();
    const relayArg = vi.mocked(relayRequest).mock.calls[0][0];
    expect(relayArg.path).toBe("/api/apps/my-app/deploy");
    expect(relayArg.serverId).toBe("srv-a");
    expect(relayArg.method).toBe("POST");

    // After relay succeeds: deploy.update marks success
    expect(mDeploy.update).toHaveBeenCalled();
    const deployUpdateData = mDeploy.update.mock.calls[0][0].data;
    expect(deployUpdateData.status).toBe("success");
  });
});

// ── Relay failure ─────────────────────────────────────────────────────────────

describe("checkScheduled — relay failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes recoverBrokenDeploy when relayRequest rejects", async () => {
    const app = { id: "app-1", name: "my-app" };
    const deploy = { id: "deploy-1" };

    mScheduledDeploy.findMany.mockResolvedValue([makeDueEntry()]);
    mScheduledDeploy.update.mockResolvedValue({});
    mApp.upsert.mockResolvedValue(app);
    mApp.update.mockResolvedValue({});
    mDeploy.create.mockResolvedValue(deploy);
    vi.mocked(relayRequest).mockRejectedValue(new Error("Connection refused"));

    await checkScheduled();

    // Flush the fire-and-forget IIFE so the catch block runs
    await new Promise((r) => setTimeout(r, 0));

    expect(recoverBrokenDeploy).toHaveBeenCalledOnce();
    const recoveryArgs = vi.mocked(recoverBrokenDeploy).mock.calls[0];
    // recoverBrokenDeploy(deployId, appId, serverId, appName, errMsg)
    expect(recoveryArgs[0]).toBe("deploy-1"); // deployId
    expect(recoveryArgs[1]).toBe("app-1");    // appId
    expect(recoveryArgs[2]).toBe("srv-a");    // serverId
    expect(recoveryArgs[3]).toBe("my-app");   // appName
  });
});
