import { describe, expect, it, vi, beforeEach } from "vitest";

// recoverStuckDeploys() behavior pinned here (see deploy-panel#130 for the
// original incident, this PR for the exclusion/re-entrancy/compare-and-set
// hardening):
//
// 1. It must exclude deploy ids this process still has active
//    (deploy-recovery.ts's active-deploy registry, populated by streamDeploy
//    and by both rollback routes), so the now-periodic sweep (see scheduler.ts's
//    startScheduler) does not eventually finalize a deploy that is simply
//    running long, not actually stuck.
// 2. The recovery note it writes into `log` must be a JSON step inside the
//    same parsed-array shape every other writer uses (stream-deploy.ts,
//    deploy-recovery.ts), not bare text appended to the column: a bare
//    string breaks routes/deploys.ts's/routes/v1.ts's
//    JSON.parse(deploy.log), silently rendering `steps: []` for exactly
//    these recovered records.
// 3. Two sweep passes must not run concurrently (re-entrancy guard), and
//    the per-record finalize is a compare-and-set (`updateMany` scoped to
//    `status: "running"`) so a record another path already resolved is
//    left alone instead of being clobbered.

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    deploy: {
      findMany: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    app: { update: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../src/lib/relay.js", () => ({
  relayRequest: vi.fn(),
}));

import { prisma } from "../src/lib/prisma.js";
import { relayRequest } from "../src/lib/relay.js";
import { recoverStuckDeploys } from "../src/lib/startup.js";
import { registerActiveDeploy, clearActiveDeploys } from "../src/lib/deploy-recovery.js";

const mFindMany = (prisma.deploy as any).findMany as ReturnType<typeof vi.fn>;
const mUpdateMany = (prisma.deploy as any).updateMany as ReturnType<typeof vi.fn>;
const mDeployFindFirst = (prisma.deploy as any).findFirst as ReturnType<typeof vi.fn>;
const mAppUpdate = (prisma.app as any).update as ReturnType<typeof vi.fn>;
const mRelay = relayRequest as unknown as ReturnType<typeof vi.fn>;

const lastCall = (m: ReturnType<typeof vi.fn>) => m.mock.calls[m.mock.calls.length - 1][0];

const makeStuckDeploy = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "d1",
  appId: "a1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  log: null,
  app: { name: "thd" },
  server: { id: "srv-a", relayUrl: null, relayToken: null },
  ...overrides,
});

describe("recoverStuckDeploys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearActiveDeploys();
    mUpdateMany.mockResolvedValue({ count: 1 });
    mDeployFindFirst.mockResolvedValue(null);
  });

  it("writes the recovery note as a JSON step, appended to whatever real steps were already in the log, instead of bare text", async () => {
    mFindMany.mockResolvedValue([
      makeStuckDeploy({ log: JSON.stringify([{ name: "compose up", status: "success", durationMs: 500 }]) }),
    ]);

    await recoverStuckDeploys();

    const writtenLog = lastCall(mUpdateMany).data.log;
    // Must not throw: proves the write is valid JSON, not bare text, the
    // exact shape routes/deploys.ts's JSON.parse(deploy.log) requires.
    const steps = JSON.parse(writtenLog);
    expect(steps[0]).toMatchObject({ name: "compose up", status: "success" });
    expect(steps.at(-1)).toMatchObject({ name: "startup-recovery" });
    expect(steps.at(-1).output).toContain("was stuck on running");
  });

  it("excludes deploy ids this process still has active (the active-deploy registry) from the stuck-sweep query", async () => {
    mFindMany.mockResolvedValue([]);
    registerActiveDeploy("still-active-1");

    await recoverStuckDeploys();

    const queryArgs = mFindMany.mock.calls[0][0];
    expect(queryArgs.where.id.notIn).toContain("still-active-1");
  });

  it("omits the `id` filter entirely when the active-deploy registry is empty, instead of passing notIn: []", async () => {
    mFindMany.mockResolvedValue([]);

    await recoverStuckDeploys();

    const queryArgs = mFindMany.mock.calls[0][0];
    expect(queryArgs.where.id).toBeUndefined();
    expect(queryArgs.where.status).toBe("running");
  });

  it("orders the stuck-deploy query oldest-first (createdAt asc)", async () => {
    mFindMany.mockResolvedValue([]);

    await recoverStuckDeploys();

    const queryArgs = mFindMany.mock.calls[0][0];
    expect(queryArgs.orderBy).toEqual({ createdAt: "asc" });
  });

  // Without orderBy, a single pass sweeping two orphaned deploys of the SAME
  // app left the app.status verdict to whichever row the DB happened to
  // return last, not necessarily the newer one. Oldest-first guarantees the
  // for-loop processes the newer record last, so its verdict is the one
  // that survives (each candidate's app.update, when written, overwrites
  // the previous one's).
  it("when two orphaned deploys of the same app are swept in one pass, the app.status write reflects whichever is processed last (oldest-first ordering makes that the newest)", async () => {
    mFindMany.mockResolvedValue([
      makeStuckDeploy({
        id: "older",
        appId: "a1",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        server: { id: "srv-a", relayUrl: null, relayToken: null },
      }),
      makeStuckDeploy({
        id: "newer",
        appId: "a1",
        createdAt: new Date("2026-01-01T00:05:00Z"),
        server: { id: "srv-a", relayUrl: "http://relay.example", relayToken: null },
      }),
    ]);
    // Older record: relay unreachable -> interrupted/unknown. Newer record:
    // relay preflight passes -> success/healthy. If the older record's
    // verdict won, the final app.update would be "unknown"; asserting
    // "healthy" pins that the newer (later-processed) verdict is the one
    // left standing.
    mRelay.mockResolvedValue({ app: "thd", passed: true });

    await recoverStuckDeploys();

    const appUpdateCalls = mAppUpdate.mock.calls.map((c) => c[0]);
    expect(appUpdateCalls.length).toBeGreaterThan(0);
    expect(appUpdateCalls.at(-1).data.status).toBe("healthy");
  });

  it("marks the deploy success/healthy when the relay preflight passes", async () => {
    mFindMany.mockResolvedValue([
      makeStuckDeploy({ id: "d2", appId: "a2", app: { name: "thd2" }, server: { id: "srv-a", relayUrl: "http://relay.example", relayToken: null } }),
    ]);
    mRelay.mockResolvedValue({ app: "thd2", passed: true });

    await recoverStuckDeploys();

    expect(lastCall(mUpdateMany).data.status).toBe("success");
    expect(lastCall(mAppUpdate).data.status).toBe("healthy");
    const steps = JSON.parse(lastCall(mUpdateMany).data.log);
    expect(steps.at(-1).status).toBe("success");
  });

  it("marks the deploy interrupted when the relay is unreachable, recording a failure step", async () => {
    mFindMany.mockResolvedValue([
      makeStuckDeploy({ id: "d3", appId: "a3", app: { name: "thd3" }, server: { id: "srv-a", relayUrl: "http://relay.example", relayToken: null } }),
    ]);
    mRelay.mockRejectedValue(new Error("relay unreachable"));

    await recoverStuckDeploys();

    expect(lastCall(mUpdateMany).data.status).toBe("interrupted");
    expect(lastCall(mAppUpdate).data.status).toBe("unknown");
    const steps = JSON.parse(lastCall(mUpdateMany).data.log);
    expect(steps.at(-1).status).toBe("failure");
  });

  it("compare-and-set: does not touch app.status when updateMany reports the record was already moved off \"running\" by another path", async () => {
    mFindMany.mockResolvedValue([makeStuckDeploy()]);
    mUpdateMany.mockResolvedValue({ count: 0 });

    await recoverStuckDeploys();

    expect(mUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "d1", status: "running" } }),
    );
    expect(mAppUpdate).not.toHaveBeenCalled();
  });

  it("skips the app.update when another deploy for the SAME app is still registered active, to avoid clobbering a live \"deploying\" status", async () => {
    mFindMany.mockResolvedValue([makeStuckDeploy()]);
    mDeployFindFirst.mockResolvedValue({ id: "newer-live-deploy" });

    await recoverStuckDeploys();

    expect(mUpdateMany).toHaveBeenCalledOnce();
    expect(mAppUpdate).not.toHaveBeenCalled();
  });

  it("one record failing does not abort the rest of the pass", async () => {
    mFindMany.mockResolvedValue([
      makeStuckDeploy({ id: "bad", appId: "a-bad" }),
      makeStuckDeploy({ id: "good", appId: "a-good", app: { name: "good-app" } }),
    ]);
    mUpdateMany.mockImplementation((args: any) => {
      if (args.where.id === "bad") throw new Error("db blip");
      return Promise.resolve({ count: 1 });
    });

    await recoverStuckDeploys();

    const finalizedIds = mUpdateMany.mock.calls.map((c) => c[0].where.id);
    expect(finalizedIds).toContain("good");
  });

  it("does not run two sweep passes concurrently (re-entrancy guard)", async () => {
    let releaseFindMany!: (v: unknown[]) => void;
    mFindMany.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFindMany = resolve;
        }),
    );

    const firstPass = recoverStuckDeploys();
    await vi.waitFor(() => expect(mFindMany).toHaveBeenCalledTimes(1));

    // A second call while the first is still awaiting its query must be a
    // no-op: it must not issue a second findMany.
    const secondPass = recoverStuckDeploys();
    await secondPass;
    expect(mFindMany).toHaveBeenCalledTimes(1);

    releaseFindMany([]);
    await firstPass;
  });
});
