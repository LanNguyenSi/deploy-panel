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
import { recoverStuckDeploys, RELAY_CLOCK_TOLERANCE_MS } from "../src/lib/startup.js";
import { registerActiveDeploy, clearActiveDeploys } from "../src/lib/deploy-recovery.js";

const mFindMany = (prisma.deploy as any).findMany as ReturnType<typeof vi.fn>;
const mUpdateMany = (prisma.deploy as any).updateMany as ReturnType<typeof vi.fn>;
const mDeployFindFirst = (prisma.deploy as any).findFirst as ReturnType<typeof vi.fn>;
const mAppUpdate = (prisma.app as any).update as ReturnType<typeof vi.fn>;
const mRelay = relayRequest as unknown as ReturnType<typeof vi.fn>;

const lastCall = (m: ReturnType<typeof vi.fn>) => m.mock.calls[m.mock.calls.length - 1][0];

// Relay mock: preflight and app-detail answer by path. `detail` is what
// GET /api/apps/:name returns (agent-relay getAppDetail + recentDeploys).
const mockRelay = (opts: {
  passed?: boolean;
  detail?: { commit?: string; recentDeploys?: Array<Record<string, unknown>> };
}) => {
  mRelay.mockImplementation(async ({ path }: { path: string }) => {
    if (path.endsWith("/preflight")) return { app: "x", passed: opts.passed ?? true };
    return { app: { name: "x", containers: "[]", ...(opts.detail ?? {}) } };
  });
};

const DEPLOY_START = new Date("2026-01-01T00:00:00Z");
// A relay history entry for a deploy that finished after DEPLOY_START: it
// ended at 00:03:00 after running 60s, so it began at 00:02:00, two minutes
// after the stuck record's start, and was triggered by an HTTP call like the
// panel's own deploys.
const relayDeployAfterStart = (over: Record<string, unknown> = {}) => ({
  id: "d-1",
  status: "success",
  commitBefore: "oldsha1111111",
  commitAfter: "newsha2222222",
  durationMs: 60_000,
  triggeredBy: "api",
  createdAt: "2026-01-01T00:03:00.000Z",
  ...over,
});

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
    mockRelay({
      detail: { commit: "newsha2", recentDeploys: [relayDeployAfterStart({ createdAt: "2026-01-01T00:06:00.000Z" })] },
    });

    await recoverStuckDeploys();

    const appUpdateCalls = mAppUpdate.mock.calls.map((c) => c[0]);
    expect(appUpdateCalls.length).toBeGreaterThan(0);
    expect(appUpdateCalls.at(-1).data.status).toBe("healthy");
  });

  it("marks the deploy success/healthy when the relay preflight passes and the relay proves the target was reached", async () => {
    mFindMany.mockResolvedValue([
      makeStuckDeploy({ id: "d2", appId: "a2", app: { name: "thd2" }, server: { id: "srv-a", relayUrl: "http://relay.example", relayToken: null } }),
    ]);
    mockRelay({
      detail: { commit: "newsha2", recentDeploys: [relayDeployAfterStart()] },
    });

    await recoverStuckDeploys();

    expect(lastCall(mUpdateMany).data.status).toBe("success");
    expect(lastCall(mAppUpdate).data.status).toBe("healthy");
    const steps = JSON.parse(lastCall(mUpdateMany).data.log);
    expect(steps.at(-1).status).toBe("success");
  });

  describe("a recovered deploy is success only when the app reached the target", () => {
    const relayDeploy = (over: Record<string, unknown> = {}) =>
      makeStuckDeploy({
        id: "t1",
        appId: "at1",
        createdAt: DEPLOY_START,
        app: { name: "event-booking-system" },
        server: { id: "srv-a", relayUrl: "http://relay.example", relayToken: null },
        ...over,
      });

    const finalizedStatus = () => lastCall(mUpdateMany).data.status;
    const recoveryOutput = () => JSON.parse(lastCall(mUpdateMany).data.log).at(-1).output as string;

    it("finalizes as interrupted, not success, when preflight passes but the repo HEAD is still the old commit and the relay recorded no deploy since the start", async () => {
      mFindMany.mockResolvedValue([relayDeploy()]);
      mockRelay({
        passed: true,
        detail: {
          commit: "oldsha1",
          // The only relay record predates this deploy's start and ended on
          // the old commit: the deploy was cut off before it changed anything.
          recentDeploys: [relayDeployAfterStart({ createdAt: "2025-12-31T23:00:00.000Z", commitAfter: "oldsha1111111" })],
        },
      });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
      expect(lastCall(mAppUpdate).data.status).toBe("unknown");
      const steps = JSON.parse(lastCall(mUpdateMany).data.log);
      expect(steps.at(-1).status).toBe("failure");
      expect(recoveryOutput()).toContain("check failed: target not reached");
      expect(recoveryOutput()).toContain("recorded no deploy since");
    });

    it("finalizes as interrupted when the relay has no deploy history at all", async () => {
      mFindMany.mockResolvedValue([relayDeploy()]);
      mockRelay({ detail: { commit: "oldsha1", recentDeploys: [] } });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
    });

    it("finalizes as interrupted when the relay reports no repo HEAD", async () => {
      mFindMany.mockResolvedValue([relayDeploy()]);
      mockRelay({ detail: { recentDeploys: [relayDeployAfterStart()] } });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
      expect(recoveryOutput()).toContain("no repo HEAD");
    });

    it("finalizes as interrupted when the repo HEAD does not match the target commit, even though a deploy was recorded after the start", async () => {
      mFindMany.mockResolvedValue([relayDeploy({ commitAfter: "newsha2222222" })]);
      mockRelay({
        detail: { commit: "oldsha1", recentDeploys: [relayDeployAfterStart({ commitAfter: "newsha2222222" })] },
      });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
      expect(recoveryOutput()).toContain("does not match the target commit");
    });

    it("finalizes as interrupted when the relay's deploy after the start did not succeed", async () => {
      mFindMany.mockResolvedValue([relayDeploy()]);
      mockRelay({
        detail: { commit: "newsha2", recentDeploys: [relayDeployAfterStart({ status: "failed" })] },
      });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
      expect(recoveryOutput()).toContain("ended failed");
    });

    it("takes the target from the relay entry, never from the deploy record: a record-side commitAfter that disagrees with HEAD does not decide the verdict", async () => {
      // A running row never carries commitAfter, so the record is not a target
      // source. If it were consulted, this stale value would wrongly reject.
      mFindMany.mockResolvedValue([relayDeploy({ commitAfter: "stale0000000" })]);
      mockRelay({
        detail: { commit: "newsha2", recentDeploys: [relayDeployAfterStart()] },
      });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("success");
    });

    it("finalizes as interrupted when the relay recorded more than one deploy since the start, even when the newest succeeded on HEAD (ambiguous)", async () => {
      mFindMany.mockResolvedValue([relayDeploy()]);
      mockRelay({
        detail: {
          commit: "newsha2",
          recentDeploys: [
            relayDeployAfterStart({ id: "d-2", createdAt: "2026-01-01T00:04:00.000Z" }),
            relayDeployAfterStart({ id: "d-1", createdAt: "2026-01-01T00:03:00.000Z" }),
          ],
        },
      });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
      expect(recoveryOutput()).toContain("2 deploys or rollbacks since");
    });

    it("finalizes as interrupted when a rollback was recorded after the start and HEAD is the rollback commit (a rollback records no duration)", async () => {
      mFindMany.mockResolvedValue([relayDeploy()]);
      // The stuck deploy never pulled; an operator then rolled back to an
      // older commit. The rollback entry is a success whose commitAfter equals
      // HEAD, so without the guards this would read as this deploy's success.
      mockRelay({
        detail: {
          commit: "rollbk3",
          recentDeploys: [
            relayDeployAfterStart({ id: "d-9", commitBefore: "oldsha1111111", commitAfter: "rollbk3333333", durationMs: 0 }),
          ],
        },
      });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
      expect(recoveryOutput()).toContain("no deploy duration");
    });

    it("finalizes as interrupted when the relay entry since the start has no durationMs field at all", async () => {
      mFindMany.mockResolvedValue([relayDeploy()]);
      mockRelay({
        detail: { commit: "newsha2", recentDeploys: [relayDeployAfterStart({ durationMs: undefined })] },
      });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
    });

    it("finalizes as interrupted when the entry since the start was triggered by something other than the panel's HTTP deploy call", async () => {
      mFindMany.mockResolvedValue([relayDeploy()]);
      mockRelay({
        detail: { commit: "newsha2", recentDeploys: [relayDeployAfterStart({ triggeredBy: "mcp" })] },
      });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
      expect(recoveryOutput()).toContain('triggered by "mcp"');
    });

    it("finalizes as interrupted when the entry's own start predates the stuck start (an earlier deploy recorded after it, e.g. relay clock ahead)", async () => {
      mFindMany.mockResolvedValue([relayDeploy()]);
      // Recorded at 00:03 but ran 4 minutes: it began at 23:59, before 00:00.
      mockRelay({
        detail: {
          commit: "newsha2",
          recentDeploys: [relayDeployAfterStart({ durationMs: 4 * 60_000 })],
        },
      });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
      expect(recoveryOutput()).toContain("is an earlier deploy");
    });

    it("tolerates relay clock skew up to exactly RELAY_CLOCK_TOLERANCE_MS before the stuck start, and not a millisecond more", async () => {
      // Entry recorded at 00:03:00; with durationMs = 180000 + tolerance it
      // began exactly `tolerance` before the stuck start.
      mFindMany.mockResolvedValue([relayDeploy()]);
      mockRelay({
        detail: {
          commit: "newsha2",
          recentDeploys: [relayDeployAfterStart({ durationMs: 180_000 + RELAY_CLOCK_TOLERANCE_MS })],
        },
      });
      await recoverStuckDeploys();
      expect(finalizedStatus()).toBe("success");

      vi.clearAllMocks();
      mUpdateMany.mockResolvedValue({ count: 1 });
      mDeployFindFirst.mockResolvedValue(null);
      mFindMany.mockResolvedValue([relayDeploy()]);
      mockRelay({
        detail: {
          commit: "newsha2",
          recentDeploys: [relayDeployAfterStart({ durationMs: 180_000 + RELAY_CLOCK_TOLERANCE_MS + 1 })],
        },
      });
      await recoverStuckDeploys();
      expect(finalizedStatus()).toBe("interrupted");
    });

    it("pins the inclusive start boundary: an entry recorded exactly at the stuck record's createdAt counts, one a millisecond earlier does not", async () => {
      mFindMany.mockResolvedValue([relayDeploy()]);
      mockRelay({
        detail: {
          commit: "newsha2",
          recentDeploys: [relayDeployAfterStart({ createdAt: DEPLOY_START.toISOString(), durationMs: 5_000 })],
        },
      });
      await recoverStuckDeploys();
      expect(finalizedStatus()).toBe("success");

      vi.clearAllMocks();
      mUpdateMany.mockResolvedValue({ count: 1 });
      mDeployFindFirst.mockResolvedValue(null);
      mFindMany.mockResolvedValue([relayDeploy()]);
      mockRelay({
        detail: {
          commit: "newsha2",
          recentDeploys: [
            relayDeployAfterStart({ createdAt: new Date(DEPLOY_START.getTime() - 1).toISOString(), durationMs: 5_000 }),
          ],
        },
      });
      await recoverStuckDeploys();
      expect(finalizedStatus()).toBe("interrupted");
      expect(recoveryOutput()).toContain("recorded no deploy since");
    });

    it("finalizes as interrupted, without asking the relay for history, when another panel deploy row for the app was created after the stuck one", async () => {
      mFindMany.mockResolvedValue([relayDeploy()]);
      mDeployFindFirst.mockImplementation(async (args: any) =>
        args.where.createdAt?.gt ? { id: "later-rollback" } : null,
      );
      // Relay history that would otherwise read as a clean success.
      mockRelay({ detail: { commit: "newsha2", recentDeploys: [relayDeployAfterStart()] } });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
      expect(recoveryOutput()).toContain("another deploy or rollback of this app (later-rollback)");
      expect(mRelay.mock.calls.map((c) => c[0].path)).toEqual(["/api/apps/event-booking-system/preflight"]);
      // Scoped to this app, to rows created strictly after this one, and not
      // to the record itself.
      const laterQuery = mDeployFindFirst.mock.calls.map((c) => c[0]).find((a: any) => a.where.createdAt?.gt);
      expect(laterQuery.where).toEqual({
        appId: "at1",
        id: { not: "t1" },
        createdAt: { gt: DEPLOY_START },
      });
    });

    it("keeps the panel's own self-deploy a success even when a later deploy row exists for it", async () => {
      mFindMany.mockResolvedValue([relayDeploy({ app: { name: "deploy-panel" } })]);
      mDeployFindFirst.mockImplementation(async (args: any) =>
        args.where.createdAt?.gt ? { id: "later" } : null,
      );
      mockRelay({ passed: true });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("success");
    });

    it("accepts a short HEAD against a full target sha (prefix match)", async () => {
      mFindMany.mockResolvedValue([relayDeploy()]);
      mockRelay({
        detail: { commit: "newsha2", recentDeploys: [relayDeployAfterStart({ commitAfter: "newsha2222222abcdef" })] },
      });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("success");
      expect(lastCall(mAppUpdate).data.status).toBe("healthy");
    });

    it("does not let a too-short HEAD or target match everything", async () => {
      mFindMany.mockResolvedValue([relayDeploy()]);
      mockRelay({
        detail: { commit: "n", recentDeploys: [relayDeployAfterStart({ commitAfter: "n" })] },
      });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
    });

    it("stays interrupted when the app-detail lookup fails after a passing preflight", async () => {
      mFindMany.mockResolvedValue([relayDeploy()]);
      mRelay.mockImplementation(async ({ path }: { path: string }) => {
        if (path.endsWith("/preflight")) return { app: "x", passed: true };
        throw new Error("detail unreachable");
      });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
    });

    it("keeps the panel's own self-deploy on the preflight-only verdict: success even with no relay history since the start", async () => {
      mFindMany.mockResolvedValue([relayDeploy({ app: { name: "deploy-panel" } })]);
      // No relay record since the start and a HEAD that would fail the target
      // check for any other app: the self-deploy path must not consult it.
      mockRelay({ passed: true, detail: { commit: "oldsha1", recentDeploys: [] } });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("success");
      expect(lastCall(mAppUpdate).data.status).toBe("healthy");
      expect(mRelay).toHaveBeenCalledTimes(1);
      expect(mRelay.mock.calls[0][0].path).toBe("/api/apps/deploy-panel/preflight");
    });

    it("a self-deploy whose preflight does not pass is still interrupted", async () => {
      mFindMany.mockResolvedValue([relayDeploy({ app: { name: "deploy-panel" } })]);
      mockRelay({ passed: false });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
      expect(recoveryOutput()).toContain("preflight did not pass");
    });

    it("honours PANEL_SELF_APP_NAME for a panel registered under another relay app name", async () => {
      vi.stubEnv("PANEL_SELF_APP_NAME", "my-panel");
      try {
        mFindMany.mockResolvedValue([relayDeploy({ app: { name: "my-panel" } })]);
        mockRelay({ passed: true, detail: { commit: "oldsha1", recentDeploys: [] } });

        await recoverStuckDeploys();

        expect(finalizedStatus()).toBe("success");
      } finally {
        vi.unstubAllEnvs();
      }
    });
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

  // Mutation probe (this PR): the prior version of this test mocked
  // findFirst's return value unconditionally, so it passed identically
  // whether the liveSibling query's `id: { in: listActiveDeployIds() } }`
  // clause used the real registry or `[]`; the mock never looked at its
  // own arguments. This version's findFirst mock only reports a live
  // sibling when the id it was actually asked to look up (from the real
  // registry, via registerActiveDeploy) appears in the query's `in` list,
  // so replacing `listActiveDeployIds()` at startup.ts:158 with `[]` makes
  // this test fail: the query would then always exclude the registered id
  // and the app.status write would no longer be skipped.
  it("collects an old orphaned deploy for app X while a NEWER deploy for X is registered active, and does not clobber app.status", async () => {
    mFindMany.mockResolvedValue([makeStuckDeploy({ id: "orphan", appId: "aX" })]);
    registerActiveDeploy("newer-registered-for-aX");
    mDeployFindFirst.mockImplementation(async (args: any) => {
      const ids: string[] = args.where.id.in;
      const scopedToApp = args.where.appId === "aX" && args.where.status === "running";
      return scopedToApp && ids.includes("newer-registered-for-aX")
        ? { id: "newer-registered-for-aX" }
        : null;
    });

    await recoverStuckDeploys();

    // The orphaned "old" record is still finalized (compare-and-set
    // succeeds, count: 1 by default)...
    expect(mUpdateMany).toHaveBeenCalledOnce();
    expect(mUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "orphan", status: "running" } }),
    );
    // ...but the app-level status write is skipped, since a newer deploy
    // for the same app is genuinely still running.
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
