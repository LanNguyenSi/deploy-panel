import { describe, expect, it, vi, beforeEach } from "vitest";

// Closes two gaps found in the batch-25 review of task 1f6895f6 (fixed main
// paths in deploy-panel#130 + agent-relay#75):
//
// 1. recoverStuckDeploys() must exclude deploy ids this process still has
//    active (deploy-recovery.ts's activeDeployIds, populated by
//    streamDeploy) — otherwise the now-periodic sweep (see scheduler.ts's
//    startScheduler) would eventually finalize a deploy that is simply
//    running long, not actually stuck.
// 2. The recovery note it writes into `log` must be a JSON step inside the
//    same parsed-array shape every other writer uses (stream-deploy.ts,
//    deploy-recovery.ts), not bare text appended to the column — a bare
//    string breaks routes/deploys.ts's/routes/v1.ts's
//    JSON.parse(deploy.log), silently rendering `steps: []` for exactly
//    these recovered records.

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    deploy: { findMany: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    app: { update: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../src/lib/relay.js", () => ({
  relayRequest: vi.fn(),
}));

import { prisma } from "../src/lib/prisma.js";
import { relayRequest } from "../src/lib/relay.js";
import { recoverStuckDeploys } from "../src/lib/startup.js";
import { activeDeployIds } from "../src/lib/deploy-recovery.js";

const mFindMany = (prisma.deploy as any).findMany as ReturnType<typeof vi.fn>;
const mDeployUpdate = (prisma.deploy as any).update as ReturnType<typeof vi.fn>;
const mAppUpdate = (prisma.app as any).update as ReturnType<typeof vi.fn>;
const mRelay = relayRequest as unknown as ReturnType<typeof vi.fn>;

const lastCall = (m: ReturnType<typeof vi.fn>) => m.mock.calls[m.mock.calls.length - 1][0];

describe("recoverStuckDeploys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeDeployIds.clear();
  });

  it("writes the recovery note as a JSON step, appended to whatever real steps were already in the log, instead of bare text", async () => {
    mFindMany.mockResolvedValue([
      {
        id: "d1",
        appId: "a1",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        log: JSON.stringify([{ name: "compose up", status: "success", durationMs: 500 }]),
        app: { name: "thd" },
        server: { id: "srv-a", relayUrl: null, relayToken: null },
      },
    ]);

    await recoverStuckDeploys();

    const writtenLog = lastCall(mDeployUpdate).data.log;
    // Must not throw — proves the write is valid JSON, not bare text, the
    // exact shape routes/deploys.ts's JSON.parse(deploy.log) requires.
    const steps = JSON.parse(writtenLog);
    expect(steps[0]).toMatchObject({ name: "compose up", status: "success" });
    expect(steps.at(-1)).toMatchObject({ name: "startup-recovery" });
    expect(steps.at(-1).output).toContain("was stuck on running");
  });

  it("excludes deploy ids this process still has active (activeDeployIds) from the stuck-sweep query", async () => {
    mFindMany.mockResolvedValue([]);
    activeDeployIds.add("still-active-1");

    await recoverStuckDeploys();

    const queryArgs = mFindMany.mock.calls[0][0];
    expect(queryArgs.where.id.notIn).toContain("still-active-1");
  });

  it("marks the deploy success/healthy when the relay preflight passes", async () => {
    mFindMany.mockResolvedValue([
      {
        id: "d2",
        appId: "a2",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        log: null,
        app: { name: "thd2" },
        server: { id: "srv-a", relayUrl: "http://relay.example", relayToken: null },
      },
    ]);
    mRelay.mockResolvedValue({ app: "thd2", passed: true });

    await recoverStuckDeploys();

    expect(lastCall(mDeployUpdate).data.status).toBe("success");
    expect(lastCall(mAppUpdate).data.status).toBe("healthy");
    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps.at(-1).status).toBe("success");
  });

  it("marks the deploy interrupted when the relay is unreachable, recording a failure step", async () => {
    mFindMany.mockResolvedValue([
      {
        id: "d3",
        appId: "a3",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        log: null,
        app: { name: "thd3" },
        server: { id: "srv-a", relayUrl: "http://relay.example", relayToken: null },
      },
    ]);
    mRelay.mockRejectedValue(new Error("relay unreachable"));

    await recoverStuckDeploys();

    expect(lastCall(mDeployUpdate).data.status).toBe("interrupted");
    expect(lastCall(mAppUpdate).data.status).toBe("unknown");
    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps.at(-1).status).toBe("failure");
  });
});
