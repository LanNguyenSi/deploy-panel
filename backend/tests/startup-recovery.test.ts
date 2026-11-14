import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

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
    app: {
      update: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({ liveUrl: null }),
    },
  },
}));

vi.mock("../src/lib/relay.js", () => ({
  relayRequest: vi.fn(),
}));

// The real health gate runs in these tests; only its clock, DNS and HTTP are
// replaced (no sleeping between polls, a public address for every host, a
// scripted route), so a sweep pass costs no wall time.
const gateEnv = vi.hoisted(() => ({
  fetch: vi.fn(),
}));
vi.mock("../src/lib/post-deploy-gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/post-deploy-gate.js")>();
  return {
    ...actual,
    verifyDeployHealth: vi.fn((opts: Parameters<typeof actual.verifyDeployHealth>[0]) =>
      actual.verifyDeployHealth({
        ...opts,
        sleepImpl: async () => {},
        fetchImpl: gateEnv.fetch as unknown as typeof fetch,
        lookupImpl: async () => [{ address: "93.184.216.34" }],
      }),
    ),
  };
});

import { prisma } from "../src/lib/prisma.js";
import { relayRequest } from "../src/lib/relay.js";
import { verifyDeployHealth } from "../src/lib/post-deploy-gate.js";
import { recoverStuckDeploys, RELAY_CLOCK_TOLERANCE_MS } from "../src/lib/startup.js";
import { registerActiveDeploy, clearActiveDeploys } from "../src/lib/deploy-recovery.js";

const mFindMany = (prisma.deploy as any).findMany as ReturnType<typeof vi.fn>;
const mUpdateMany = (prisma.deploy as any).updateMany as ReturnType<typeof vi.fn>;
const mDeployFindFirst = (prisma.deploy as any).findFirst as ReturnType<typeof vi.fn>;
const mAppUpdate = (prisma.app as any).update as ReturnType<typeof vi.fn>;
const mAppFindMany = (prisma.app as any).findMany as ReturnType<typeof vi.fn>;
const mAppUpdateMany = (prisma.app as any).updateMany as ReturnType<typeof vi.fn>;
const mAppFindUnique = (prisma.app as any).findUnique as ReturnType<typeof vi.fn>;
const mRelay = relayRequest as unknown as ReturnType<typeof vi.fn>;
const mVerify = verifyDeployHealth as unknown as ReturnType<typeof vi.fn>;

// deploy.findMany serves two queries: the running rows and (after them) the
// unverified self-deploy rows of upgradeSelfDeploys. Route by the status asked for.
let upgradeRows: unknown[] = [];
const setStuck = (rows: unknown[]) =>
  mFindMany.mockImplementation(async (args: any) => (args?.where?.status === "interrupted" ? upgradeRows : rows));

const lastCall = (m: ReturnType<typeof vi.fn>) => m.mock.calls[m.mock.calls.length - 1][0];

// Relay mock: preflight and app-detail answer by path. `detail` is what
// GET /api/apps/:name returns (agent-relay getAppDetail + recentDeploys).
const mockRelay = (opts: {
  passed?: boolean;
  /** What GET /health returns; omitted means the relay reports no version. */
  health?: { status?: string; version?: string };
  detail?: { commit?: string; recentDeploys?: Array<Record<string, unknown>>; containers?: string };
}) => {
  mRelay.mockImplementation(async ({ path }: { path: string }) => {
    if (path.endsWith("/preflight")) return { app: "x", passed: opts.passed ?? true };
    if (path === "/health") return opts.health ?? { status: "ok" };
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
    mAppFindMany.mockResolvedValue([]);
    mAppUpdateMany.mockResolvedValue({ count: 1 });
    mAppFindUnique.mockResolvedValue({ liveUrl: null });
    gateEnv.fetch.mockReset();
    gateEnv.fetch.mockResolvedValue({ status: 200 });
    upgradeRows = [];
  });

  it("writes the recovery note as a JSON step, appended to whatever real steps were already in the log, instead of bare text", async () => {
    setStuck([
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
    setStuck([]);
    registerActiveDeploy("still-active-1");

    await recoverStuckDeploys();

    const queryArgs = mFindMany.mock.calls[0][0];
    expect(queryArgs.where.id.notIn).toContain("still-active-1");
  });

  it("omits the `id` filter entirely when the active-deploy registry is empty, instead of passing notIn: []", async () => {
    setStuck([]);

    await recoverStuckDeploys();

    const queryArgs = mFindMany.mock.calls[0][0];
    expect(queryArgs.where.id).toBeUndefined();
    expect(queryArgs.where.status).toBe("running");
  });

  it("orders the stuck-deploy query oldest-first (createdAt asc)", async () => {
    setStuck([]);

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
    setStuck([
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
    setStuck([
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
      setStuck([relayDeploy()]);
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
      setStuck([relayDeploy()]);
      mockRelay({ detail: { commit: "oldsha1", recentDeploys: [] } });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
    });

    it("finalizes as interrupted when the relay reports no repo HEAD", async () => {
      setStuck([relayDeploy()]);
      mockRelay({ detail: { recentDeploys: [relayDeployAfterStart()] } });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
      expect(recoveryOutput()).toContain("no repo HEAD");
    });

    it("finalizes as interrupted when the repo HEAD does not match the target commit, even though a deploy was recorded after the start", async () => {
      setStuck([relayDeploy({ commitAfter: "newsha2222222" })]);
      mockRelay({
        detail: { commit: "oldsha1", recentDeploys: [relayDeployAfterStart({ commitAfter: "newsha2222222" })] },
      });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
      expect(recoveryOutput()).toContain("does not match the target commit");
    });

    it("finalizes as interrupted when the relay's deploy after the start did not succeed", async () => {
      setStuck([relayDeploy()]);
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
      setStuck([relayDeploy({ commitAfter: "stale0000000" })]);
      mockRelay({
        detail: { commit: "newsha2", recentDeploys: [relayDeployAfterStart()] },
      });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("success");
    });

    it("finalizes as interrupted when the relay recorded more than one deploy since the start, even when the newest succeeded on HEAD (ambiguous)", async () => {
      setStuck([relayDeploy()]);
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
      setStuck([relayDeploy()]);
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

    describe("deploy-id path chosen by relay capability", () => {
      const OWN = "t1";
      const idEntry = (over: Record<string, unknown> = {}) => relayDeployAfterStart({ deployId: OWN, ...over });

      it("finalizes a stuck rollback row success via the id path: the rollback's own entry (no duration, odd timing) matches by id, succeeded and equals HEAD", async () => {
        setStuck([relayDeploy()]);
        mockRelay({
          health: { status: "ok", version: "0.6.0" },
          detail: {
            commit: "rollbk3",
            recentDeploys: [idEntry({ commitAfter: "rollbk3333333", durationMs: 0, triggeredBy: "api" })],
          },
        });

        await recoverStuckDeploys();

        expect(finalizedStatus()).toBe("success");
        expect(mAppUpdate).toHaveBeenCalled();
      });

      it("an id-capable relay by version with no entry carrying the id is not reached, even when no history entry has an id yet (first deploy after a relay upgrade)", async () => {
        setStuck([relayDeploy()]);
        // A lone non-panel deploy that the timing correlation would accept.
        mockRelay({
          health: { status: "ok", version: "0.6.0" },
          detail: { commit: "newsha2", recentDeploys: [relayDeployAfterStart()] },
        });

        await recoverStuckDeploys();

        expect(finalizedStatus()).toBe("interrupted");
        expect(recoveryOutput()).toContain("carries this deploy's id");
      });

      it("a relay below the id release keeps the timing correlation: the same lone entry is accepted", async () => {
        setStuck([relayDeploy()]);
        mockRelay({
          health: { status: "ok", version: "0.5.0" },
          detail: { commit: "newsha2", recentDeploys: [relayDeployAfterStart()] },
        });

        await recoverStuckDeploys();

        expect(finalizedStatus()).toBe("success");
      });

      it("an unreadable /health falls back to the history inference (no ids in history: timing correlation)", async () => {
        setStuck([relayDeploy()]);
        mockRelay({ detail: { commit: "newsha2", recentDeploys: [relayDeployAfterStart()] } });
        const base = mRelay.getMockImplementation()!;
        mRelay.mockImplementation(async (o: { path: string }) => {
          if (o.path === "/health") throw new Error("ECONNREFUSED");
          return base(o);
        });

        await recoverStuckDeploys();

        expect(finalizedStatus()).toBe("success");
      });
    });

    it("finalizes as interrupted when the relay entry since the start has no durationMs field at all", async () => {
      setStuck([relayDeploy()]);
      mockRelay({
        detail: { commit: "newsha2", recentDeploys: [relayDeployAfterStart({ durationMs: undefined })] },
      });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
    });

    it("finalizes as interrupted when the entry since the start was triggered by something other than the panel's HTTP deploy call", async () => {
      setStuck([relayDeploy()]);
      mockRelay({
        detail: { commit: "newsha2", recentDeploys: [relayDeployAfterStart({ triggeredBy: "mcp" })] },
      });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
      expect(recoveryOutput()).toContain('triggered by "mcp"');
    });

    it("finalizes as interrupted when the entry since the start records no trigger at all", async () => {
      setStuck([relayDeploy()]);
      const entry = relayDeployAfterStart();
      delete (entry as Record<string, unknown>).triggeredBy;
      mockRelay({ detail: { commit: "newsha2", recentDeploys: [entry] } });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
      expect(recoveryOutput()).toContain("triggered by nothing it recorded");
    });

    it("finalizes as interrupted when the entry's own start predates the stuck start (an earlier deploy recorded after it, e.g. relay clock ahead)", async () => {
      setStuck([relayDeploy()]);
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
      setStuck([relayDeploy()]);
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
      setStuck([relayDeploy()]);
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
      setStuck([relayDeploy()]);
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
      setStuck([relayDeploy()]);
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
      setStuck([relayDeploy()]);
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

    it("holds the panel's own self-deploy to the later-deploy-row check too: no preflight-only exemption", async () => {
      setStuck([relayDeploy({ app: { name: "deploy-panel" } })]);
      mDeployFindFirst.mockImplementation(async (args: any) =>
        args.where.createdAt?.gt ? { id: "later" } : null,
      );
      mockRelay({ passed: true });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
      expect(recoveryOutput()).toContain("another deploy or rollback of this app (later)");
    });

    it("accepts a short HEAD against a full target sha (prefix match)", async () => {
      setStuck([relayDeploy()]);
      mockRelay({
        detail: { commit: "newsha2", recentDeploys: [relayDeployAfterStart({ commitAfter: "newsha2222222abcdef" })] },
      });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("success");
      expect(lastCall(mAppUpdate).data.status).toBe("healthy");
    });

    it("does not let a too-short HEAD or target match everything", async () => {
      setStuck([relayDeploy()]);
      mockRelay({
        detail: { commit: "n", recentDeploys: [relayDeployAfterStart({ commitAfter: "n" })] },
      });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
    });

    it("stays interrupted when the app-detail lookup fails after a passing preflight", async () => {
      setStuck([relayDeploy()]);
      mRelay.mockImplementation(async ({ path }: { path: string }) => {
        if (path.endsWith("/preflight")) return { app: "x", passed: true };
        throw new Error("detail unreachable");
      });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
    });

    it("a self-deploy whose preflight does not pass is still interrupted", async () => {
      setStuck([relayDeploy({ app: { name: "deploy-panel" } })]);
      mockRelay({ passed: false });

      await recoverStuckDeploys();

      expect(finalizedStatus()).toBe("interrupted");
      expect(recoveryOutput()).toContain("preflight did not pass");
    });

    describe("panel self-deploy (the relay records it last)", () => {
      const MIN = 60_000;
      const ago = (ms: number) => new Date(Date.now() - ms);
      // A self-deploy that started `startedMsAgo` ago; the relay entry (when
      // present) ended 30 s after the start and ran 20 s, carrying the id.
      const selfDeploy = (startedMsAgo: number, name = "deploy-panel") =>
        relayDeploy({ id: "self1", createdAt: ago(startedMsAgo), app: { name } });
      const selfEntry = (startedMsAgo: number, over: Record<string, unknown> = {}) =>
        relayDeployAfterStart({
          deployId: "self1",
          createdAt: new Date(Date.now() - startedMsAgo + 30_000).toISOString(),
          durationMs: 20_000,
          ...over,
        });
      // By default the process has been up for a day, so the row's own start
      // anchors the grace window; the tests that move the process start say so.
      const bootedAgo = (ms: number) => vi.spyOn(process, "uptime").mockReturnValue(ms / 1000);
      beforeEach(() => {
        bootedAgo(24 * 60 * MIN);
      });
      afterEach(() => {
        vi.restoreAllMocks();
      });
      const noWrites = () => {
        expect(mUpdateMany).not.toHaveBeenCalled();
        expect(mAppUpdate).not.toHaveBeenCalled();
      };

      it("is success only on the relay's proof, and takes commits and duration from the relay entry", async () => {
        setStuck([selfDeploy(3 * MIN)]);
        mockRelay({ passed: true, detail: { commit: "newsha2", recentDeploys: [selfEntry(3 * MIN)] } });

        await recoverStuckDeploys();

        const data = lastCall(mUpdateMany).data;
        expect(data.status).toBe("success");
        expect(data.commitBefore).toBe("oldsha1111111");
        expect(data.commitAfter).toBe("newsha2222222");
        expect(data.duration).toBe(20_000);
        expect(lastCall(mAppUpdate).data.status).toBe("healthy");
        expect(mRelay.mock.calls.map((c) => c[0].path)).toContain("/api/apps/deploy-panel");
      });

      it("stays running, with no write at all, while the relay has no entry for it and it is inside the grace window", async () => {
        setStuck([selfDeploy(3 * MIN)]);
        mockRelay({ passed: true, detail: { commit: "oldsha1", recentDeploys: [] } });

        await recoverStuckDeploys();

        noWrites();
      });

      it("stays running inside the grace window on an id-capable relay whose history lacks its id", async () => {
        setStuck([selfDeploy(3 * MIN)]);
        mockRelay({
          passed: true,
          health: { status: "ok", version: "0.6.0" },
          detail: { commit: "oldsha1", recentDeploys: [relayDeployAfterStart({ deployId: "someone-else" })] },
        });

        await recoverStuckDeploys();

        noWrites();
      });

      it("ends interrupted (unverified, distinct message) once the grace window is over and the relay still has no entry", async () => {
        setStuck([selfDeploy(11 * MIN)]);
        mockRelay({ passed: true, detail: { commit: "oldsha1", recentDeploys: [] } });

        await recoverStuckDeploys();

        expect(finalizedStatus()).toBe("interrupted");
        expect(lastCall(mAppUpdate).data.status).toBe("unknown");
        expect(recoveryOutput()).toContain("the panel is up, but this self-deploy is not verified");
        expect(recoveryOutput()).toContain("recorded no deploy since");
        const data = lastCall(mUpdateMany).data;
        expect(data.commitAfter).toBeUndefined();
        expect(data.duration).toBeUndefined();
      });

      it("does not wait when the relay's id-matched entry says failed: the row ends failed", async () => {
        mFindMany.mockResolvedValue([selfDeploy(3 * MIN)]);
        mockRelay({
          passed: true,
          detail: { commit: "newsha2", recentDeploys: [selfEntry(3 * MIN, { status: "failed" })] },
        });

        await recoverStuckDeploys();

        expect(finalizedStatus()).toBe("failed");
        expect(recoveryOutput()).toContain("the relay recorded this deploy as failed");
        expect(lastCall(mUpdateMany).data.commitAfter).toBeUndefined();
        expect(lastCall(mAppUpdate).data.status).toBe("unknown");
      });

      it("a failed entry without an id match (timing correlation) is still only interrupted", async () => {
        mFindMany.mockResolvedValue([selfDeploy(3 * MIN)]);
        const entry = selfEntry(3 * MIN, { status: "failed" });
        delete (entry as Record<string, unknown>).deployId;
        mockRelay({ passed: true, detail: { commit: "newsha2", recentDeploys: [entry] } });

        await recoverStuckDeploys();

        expect(finalizedStatus()).toBe("interrupted");
      });

      it("counts the grace window from this process's start when that is later than the row's: an old row in a freshly started panel keeps waiting", async () => {
        bootedAgo(2 * MIN);
        mFindMany.mockResolvedValue([selfDeploy(30 * MIN)]);
        mockRelay({ passed: true, detail: { commit: "oldsha1", recentDeploys: [] } });

        await recoverStuckDeploys();

        noWrites();
      });

      it("a panel started long ago does not extend the window: the row's start anchors it", async () => {
        bootedAgo(5 * 60 * MIN);
        mFindMany.mockResolvedValue([selfDeploy(30 * MIN)]);
        mockRelay({ passed: true, detail: { commit: "oldsha1", recentDeploys: [] } });

        await recoverStuckDeploys();

        expect(finalizedStatus()).toBe("interrupted");
      });

      it("pins the grace edge: waits one second inside the window, ends interrupted exactly at it", async () => {
        const now = Date.now();
        const spy = vi.spyOn(Date, "now").mockReturnValue(now);
        mockRelay({ passed: true, detail: { commit: "oldsha1", recentDeploys: [] } });

        mFindMany.mockResolvedValue([relayDeploy({ id: "self1", createdAt: new Date(now - 10 * MIN + 1000), app: { name: "deploy-panel" } })]);
        await recoverStuckDeploys();
        noWrites();

        mFindMany.mockResolvedValue([relayDeploy({ id: "self1", createdAt: new Date(now - 10 * MIN), app: { name: "deploy-panel" } })]);
        await recoverStuckDeploys();
        expect(finalizedStatus()).toBe("interrupted");
        spy.mockRestore();
      });

      it("does not wait when the relay cannot be asked for the app detail: interrupted at once", async () => {
        setStuck([selfDeploy(3 * MIN)]);
        mRelay.mockImplementation(async ({ path }: { path: string }) => {
          if (path.endsWith("/preflight")) return { app: "x", passed: true };
          throw new Error("relay down");
        });

        await recoverStuckDeploys();

        expect(finalizedStatus()).toBe("interrupted");
      });

      it("never waits for any other app: no entry yet is interrupted inside the same window", async () => {
        setStuck([relayDeploy({ id: "other1", createdAt: ago(3 * MIN) })]);
        mockRelay({ passed: true, detail: { commit: "oldsha1", recentDeploys: [] } });

        await recoverStuckDeploys();

        expect(finalizedStatus()).toBe("interrupted");
        expect(recoveryOutput()).not.toContain("self-deploy");
      });

      it("honours PANEL_SELF_APP_NAME: the configured name waits, the default name no longer does", async () => {
        vi.stubEnv("PANEL_SELF_APP_NAME", "my-panel");
        try {
          mockRelay({ passed: true, detail: { commit: "oldsha1", recentDeploys: [] } });

          setStuck([selfDeploy(3 * MIN, "my-panel")]);
          await recoverStuckDeploys();
          noWrites();

          setStuck([selfDeploy(3 * MIN, "deploy-panel")]);
          await recoverStuckDeploys();
          expect(finalizedStatus()).toBe("interrupted");
        } finally {
          vi.unstubAllEnvs();
        }
      });

      it("a self-deploy entry without a positive duration still proves the deploy; the record just gets no duration", async () => {
        setStuck([selfDeploy(3 * MIN)]);
        mockRelay({ passed: true, detail: { commit: "newsha2", recentDeploys: [selfEntry(3 * MIN, { durationMs: 0 })] } });
        // Id-capable via the history entry's deployId, so the timing rules are not applied.

        await recoverStuckDeploys();

        const data = lastCall(mUpdateMany).data;
        expect(data.status).toBe("success");
        expect(data.commitAfter).toBe("newsha2222222");
        expect(data.duration).toBeUndefined();
      });
    });

    it("a non-panel app's success also carries the relay entry's commits and duration", async () => {
      setStuck([relayDeploy()]);
      mockRelay({ detail: { commit: "newsha2", recentDeploys: [relayDeployAfterStart()] } });

      await recoverStuckDeploys();

      const data = lastCall(mUpdateMany).data;
      expect(data).toMatchObject({ status: "success", commitBefore: "oldsha1111111", commitAfter: "newsha2222222", duration: 60_000 });
    });

    it("an interrupted record carries no commit or duration fields", async () => {
      setStuck([relayDeploy()]);
      mockRelay({ detail: { commit: "oldsha1", recentDeploys: [] } });

      await recoverStuckDeploys();

      const data = lastCall(mUpdateMany).data;
      expect(data.status).toBe("interrupted");
      expect(data.commitBefore).toBeUndefined();
      expect(data.commitAfter).toBeUndefined();
      expect(data.duration).toBeUndefined();
    });
  });

  it("marks the deploy interrupted when the relay is unreachable, recording a failure step", async () => {
    setStuck([
      makeStuckDeploy({ id: "d3", appId: "a3", app: { name: "thd3" }, server: { id: "srv-a", relayUrl: "http://relay.example", relayToken: null } }),
    ]);
    mRelay.mockRejectedValue(new Error("relay unreachable"));

    await recoverStuckDeploys();

    expect(lastCall(mUpdateMany).data.status).toBe("interrupted");
    expect(lastCall(mAppUpdate).data.status).toBe("unknown");
    const steps = JSON.parse(lastCall(mUpdateMany).data.log);
    expect(steps.at(-1).status).toBe("failure");
  });

  // The reference rule is finalizeDeploy (stream-deploy.ts): an app write for a
  // deploy settled as success also writes lastDeployAt; every other verdict
  // leaves it alone.
  describe("lastDeployAt on the sweep's app write", () => {
    const targetDeploy = () =>
      makeStuckDeploy({
        id: "t1",
        appId: "at1",
        createdAt: DEPLOY_START,
        app: { name: "event-booking-system" },
        server: { id: "srv-a", relayUrl: "http://relay.example", relayToken: null },
      });

    it("a settled success writes lastDeployAt (a Date) together with the healthy status", async () => {
      setStuck([targetDeploy()]);
      mockRelay({ detail: { commit: "newsha2", recentDeploys: [relayDeployAfterStart()] } });

      await recoverStuckDeploys();

      const data = lastCall(mAppUpdate).data;
      expect(data.status).toBe("healthy");
      expect(data.lastDeployAt).toBeInstanceOf(Date);
    });

    it("an interrupted settle does not carry the lastDeployAt key", async () => {
      setStuck([targetDeploy()]);
      mockRelay({ detail: { commit: "oldsha1", recentDeploys: [] } });

      await recoverStuckDeploys();

      const data = lastCall(mAppUpdate).data;
      expect(data.status).toBe("unknown");
      expect(data).not.toHaveProperty("lastDeployAt");
    });

    it("a settle failed by the relay's id-matched entry does not carry the lastDeployAt key", async () => {
      setStuck([targetDeploy()]);
      mockRelay({
        passed: true,
        detail: {
          commit: "newsha2",
          recentDeploys: [relayDeployAfterStart({ deployId: "t1", status: "failed" })],
        },
      });

      await recoverStuckDeploys();

      expect(lastCall(mUpdateMany).data.status).toBe("failed");
      const data = lastCall(mAppUpdate).data;
      expect(data.status).toBe("unknown");
      expect(data).not.toHaveProperty("lastDeployAt");
    });
  });

  it("compare-and-set: does not touch app.status when updateMany reports the record was already moved off \"running\" by another path", async () => {
    setStuck([makeStuckDeploy()]);
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
    setStuck([makeStuckDeploy({ id: "orphan", appId: "aX" })]);
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
    setStuck([
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

    setStuck([]);
    releaseFindMany([]);
    await firstPass;
  });

  describe("post-deploy health gate before a swept deploy is recorded success", () => {
    const MIN = 60_000;
    const ago = (ms: number) => new Date(Date.now() - ms);
    // A deploy that started `startedMsAgo` ago whose relay entry (id-less
    // timing correlation) ended 30 s after the start and ran 20 s.
    const row = (startedMsAgo: number, name = "deploy-panel") =>
      makeStuckDeploy({
        id: "g1",
        appId: "ag1",
        createdAt: ago(startedMsAgo),
        app: { name },
        server: { id: "srv-a", relayUrl: "http://relay.example", relayToken: null },
      });
    const entry = (startedMsAgo: number) =>
      relayDeployAfterStart({
        deployId: "g1",
        createdAt: new Date(Date.now() - startedMsAgo + 30_000).toISOString(),
        durationMs: 20_000,
      });
    const svc = (service: string, over: Record<string, unknown> = {}) => ({
      Service: service,
      Name: `proj-${service}-1`,
      State: "running",
      Health: "",
      ExitCode: 0,
      Status: "Up 2 minutes",
      ...over,
    });
    const relayWith = (startedMsAgo: number, rows: Array<Record<string, unknown>>) =>
      mockRelay({ passed: true, detail: { commit: "newsha2", recentDeploys: [entry(startedMsAgo)], containers: JSON.stringify(rows) } });
    const restartingFrontend = svc("frontend", { State: "restarting", ExitCode: 1, Status: "Restarting (1) 3 seconds ago" });
    const startingFrontend = svc("frontend", { Health: "starting" });
    const written = () => lastCall(mUpdateMany).data;
    const writtenSteps = () => JSON.parse(written().log) as Array<{ name: string; status: string; output?: string }>;
    const noWrites = () => {
      expect(mUpdateMany).not.toHaveBeenCalled();
      expect(mAppUpdate).not.toHaveBeenCalled();
    };
    // By default the process has been up for a day, so the row's own start
    // anchors the grace window; the tests that move the process start say so.
    const bootedAgo = (ms: number) => vi.spyOn(process, "uptime").mockReturnValue(ms / 1000);
    beforeEach(() => {
      bootedAgo(24 * 60 * MIN);
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it("healthy: target reached and every service up is success, with a passing gate step before the recovery step", async () => {
      setStuck([row(3 * MIN)]);
      relayWith(3 * MIN, [svc("backend"), svc("frontend")]);

      await recoverStuckDeploys();

      expect(written().status).toBe("success");
      expect(lastCall(mAppUpdate).data).toMatchObject({ status: "healthy", lastDeployAt: expect.any(Date) });
      const steps = writtenSteps();
      expect(steps.at(-2)).toMatchObject({ name: "post-deploy health gate", status: "success" });
      expect(steps.at(-1)).toMatchObject({ name: "startup-recovery", status: "success" });
    });

    it("runs the gate with the stream path's inputs: the relay app and the app's liveUrl", async () => {
      setStuck([row(3 * MIN)]);
      relayWith(3 * MIN, [svc("backend")]);
      mAppFindUnique.mockResolvedValue({ liveUrl: "https://panel.example.test" });

      await recoverStuckDeploys();

      expect(mAppFindUnique).toHaveBeenCalledWith({ where: { id: "ag1" }, select: { liveUrl: true } });
      expect(mVerify).toHaveBeenCalledWith(expect.objectContaining({ serverId: "srv-a", appName: "deploy-panel", liveUrl: "https://panel.example.test" }));
      expect(gateEnv.fetch).toHaveBeenCalledWith("https://panel.example.test", expect.anything());
      expect(written().status).toBe("success");
    });

    it("never runs the gate for a deploy the target check did not prove", async () => {
      setStuck([row(11 * MIN)]);
      mockRelay({ passed: true, detail: { commit: "oldsha1", recentDeploys: [], containers: JSON.stringify([restartingFrontend]) } });

      await recoverStuckDeploys();

      expect(mVerify).not.toHaveBeenCalled();
      expect(written().status).toBe("interrupted");
    });

    it("a sibling crashlooping after the grace is failed, the app unhealthy, and the offender named in a gate step and in the recovery step", async () => {
      setStuck([row(11 * MIN)]);
      relayWith(11 * MIN, [svc("backend"), restartingFrontend]);

      await recoverStuckDeploys();

      expect(written().status).toBe("failed");
      // The relay's entry still proved the target: its facts are kept.
      expect(written().commitAfter).toBe("newsha2222222");
      expect(written().duration).toBe(20_000);
      expect(lastCall(mAppUpdate).data).toEqual({ status: "unhealthy", lastDeployAt: expect.any(Date) });
      const steps = writtenSteps();
      expect(steps.at(-2)).toMatchObject({ name: "post-deploy health gate", status: "failure" });
      expect(steps.at(-2)!.output).toContain('service "frontend" is restarting (Restarting (1) 3 seconds ago)');
      expect(steps.at(-1)).toMatchObject({ name: "startup-recovery", status: "failure" });
      expect(steps.at(-1)!.output).toContain("Marked as failed");
      expect(steps.at(-1)!.output).toContain('check failed: post-deploy health gate: service "frontend" is restarting');
    });

    it("the same crashloop inside the grace window leaves the record running with no write", async () => {
      setStuck([row(3 * MIN)]);
      relayWith(3 * MIN, [svc("backend"), restartingFrontend]);

      await recoverStuckDeploys();

      noWrites();
    });

    it("a container still starting inside the grace window leaves the record running, and the gate polled its extended window first", async () => {
      setStuck([row(3 * MIN)]);
      relayWith(3 * MIN, [svc("backend"), startingFrontend]);

      await recoverStuckDeploys();

      noWrites();
      // 4 base polls plus the 9 the gate grants a pending-only window, plus the
      // target check's own app-detail request.
      const gatePolls = mRelay.mock.calls.filter((c) => c[0].path === "/api/apps/deploy-panel").length - 1;
      expect(gatePolls).toBe(13);
    });

    it("a container still starting after the grace is success as on the stream path, with the gate's note in the step", async () => {
      setStuck([row(11 * MIN)]);
      relayWith(11 * MIN, [svc("backend"), startingFrontend]);

      await recoverStuckDeploys();

      expect(written().status).toBe("success");
      const gateStep = writtenSteps().at(-2)!;
      expect(gateStep.name).toBe("post-deploy health gate");
      expect(gateStep.output).toContain("Passed optimistically without positive health confirmation");
      expect(gateStep.output).toContain('"frontend"');
    });

    it("a public route answering 502 inside the grace window leaves the record running, after it the deploy is failed with the status named", async () => {
      mAppFindUnique.mockResolvedValue({ liveUrl: "https://panel.example.test" });
      gateEnv.fetch.mockResolvedValue({ status: 502 });

      setStuck([row(3 * MIN)]);
      relayWith(3 * MIN, [svc("backend"), svc("frontend")]);
      await recoverStuckDeploys();
      noWrites();

      setStuck([row(11 * MIN)]);
      relayWith(11 * MIN, [svc("backend"), svc("frontend")]);
      await recoverStuckDeploys();
      expect(written().status).toBe("failed");
      expect(lastCall(mAppUpdate).data).toEqual({ status: "unhealthy", lastDeployAt: expect.any(Date) });
      expect(writtenSteps().at(-2)!.output).toContain("public route https://panel.example.test returned HTTP 502");
    });

    it("a route that was 502 and then answers is success on a later pass (the wait is not sticky)", async () => {
      mAppFindUnique.mockResolvedValue({ liveUrl: "https://panel.example.test" });
      setStuck([row(3 * MIN)]);
      relayWith(3 * MIN, [svc("backend"), svc("frontend")]);

      gateEnv.fetch.mockResolvedValue({ status: 502 });
      await recoverStuckDeploys();
      noWrites();

      gateEnv.fetch.mockResolvedValue({ status: 200 });
      await recoverStuckDeploys();
      expect(written().status).toBe("success");
    });

    it("a relay that cannot answer compose ps during the gate is not a bad signal: the relay's own entry proved the deploy, so it is success", async () => {
      setStuck([row(3 * MIN)]);
      // The target check reads the app detail once; every gate poll after it fails.
      let detailCalls = 0;
      mRelay.mockImplementation(async ({ path }: { path: string }) => {
        if (path.endsWith("/preflight")) return { app: "x", passed: true };
        if (path === "/health") return { status: "ok" };
        if (++detailCalls > 1) throw new Error("relay unreachable");
        return { app: { name: "x", containers: "[]", commit: "newsha2", recentDeploys: [entry(3 * MIN)] } };
      });

      await recoverStuckDeploys();

      expect(detailCalls).toBeGreaterThan(1);
      expect(written().status).toBe("success");
      expect(writtenSteps().at(-2)).toMatchObject({ name: "post-deploy health gate", status: "success" });
    });

    it("applies to every swept deploy, not only the panel's own app: a non-panel app with a crashlooping sibling is failed", async () => {
      setStuck([row(11 * MIN, "event-booking-system")]);
      relayWith(11 * MIN, [svc("backend"), restartingFrontend]);

      await recoverStuckDeploys();

      expect(written().status).toBe("failed");
      expect(lastCall(mAppUpdate).data).toEqual({ status: "unhealthy", lastDeployAt: expect.any(Date) });
    });

    it("a non-panel app gets the same grace, counted from the row's start", async () => {
      setStuck([row(3 * MIN, "event-booking-system")]);
      relayWith(3 * MIN, [svc("backend"), restartingFrontend]);

      await recoverStuckDeploys();

      noWrites();
    });

    it("counts the panel's grace from this process's start when that is later than the row's, and never does so for another app", async () => {
      bootedAgo(1 * MIN);
      setStuck([row(60 * MIN)]);
      mockRelay({ passed: true, detail: { commit: "newsha2", recentDeploys: [entry(60 * MIN)], containers: JSON.stringify([restartingFrontend]) } });
      await recoverStuckDeploys();
      noWrites();

      setStuck([row(60 * MIN, "event-booking-system")]);
      await recoverStuckDeploys();
      expect(written().status).toBe("failed");
    });

    it("pins the grace edge: waits one second inside it, is failed exactly at it", async () => {
      // The edge is a millisecond comparison: freeze the clock so the time
      // between building the row and sweeping it cannot move it.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));
      relayWith(10 * MIN - 1000, [restartingFrontend]);
      setStuck([row(10 * MIN - 1000)]);
      await recoverStuckDeploys();
      noWrites();

      vi.clearAllMocks();
      mUpdateMany.mockResolvedValue({ count: 1 });
      mDeployFindFirst.mockResolvedValue(null);
      mAppFindMany.mockResolvedValue([]);
      mAppFindUnique.mockResolvedValue({ liveUrl: null });
      relayWith(10 * MIN, [restartingFrontend]);
      setStuck([row(10 * MIN)]);
      await recoverStuckDeploys();
      expect(written().status).toBe("failed");
    });

    it("a gate that does not finish within its bound is unconfirmed, not unhealthy: the record waits inside the grace and passes with a note after it", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      // Once per sweep pass below; the default implementation stays for the other tests.
      mVerify.mockImplementationOnce(() => new Promise(() => {}));
      mVerify.mockImplementationOnce(() => new Promise(() => {}));

      setStuck([row(3 * MIN)]);
      relayWith(3 * MIN, [svc("backend")]);
      const waiting = recoverStuckDeploys();
      await vi.advanceTimersByTimeAsync(120_000);
      await waiting;
      noWrites();

      setStuck([row(11 * MIN)]);
      relayWith(11 * MIN, [svc("backend")]);
      const passing = recoverStuckDeploys();
      await vi.advanceTimersByTimeAsync(120_000);
      await passing;
      expect(written().status).toBe("success");
      const gateStep = writtenSteps().at(-2)!;
      expect(gateStep.status).toBe("success");
      expect(gateStep.output).toContain("Passed optimistically without positive health confirmation");
      expect(gateStep.output).toContain("did not finish within 120s");
    });

    it("stops the polling of a gate run that lost the race: its sleep between polls works before the deadline and rejects after it", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      let gateOpts: { sleepImpl: (ms: number) => Promise<void> } | undefined;
      mVerify.mockImplementationOnce((opts: any) => {
        gateOpts = opts;
        return new Promise(() => {});
      });
      setStuck([row(3 * MIN)]);
      relayWith(3 * MIN, [svc("backend")]);

      const pass = recoverStuckDeploys();
      await vi.advanceTimersByTimeAsync(0);
      const early = gateOpts!.sleepImpl(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(early).resolves.toBeUndefined();

      await vi.advanceTimersByTimeAsync(120_000);
      await pass;
      await expect(gateOpts!.sleepImpl(5_000)).rejects.toThrow("deadline");
    });

    it("a gate run that hits the deadline inside its own sleep is the same no-verdict outcome, not an error", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      // The deadline passes while the gate polls; the timer race has not fired.
      mVerify.mockImplementationOnce(async (opts: any) => {
        vi.setSystemTime(Date.now() + 121_000);
        await opts.sleepImpl(5_000);
        return { healthy: true };
      });
      setStuck([row(11 * MIN)]);
      relayWith(11 * MIN, [svc("backend")]);

      await recoverStuckDeploys();

      expect(written().status).toBe("success");
      expect(writtenSteps().at(-2)!.output).toContain("did not finish within 120s");
    });

    it("a liveUrl lookup that fails is not fatal: the gate runs without a route probe and a clean container check is success", async () => {
      mAppFindUnique.mockRejectedValue(new Error("db blip"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      setStuck([row(3 * MIN)]);
      relayWith(3 * MIN, [svc("backend"), svc("frontend")]);

      await recoverStuckDeploys();

      expect(mVerify).toHaveBeenCalledWith(expect.objectContaining({ liveUrl: null }));
      expect(gateEnv.fetch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not load liveUrl for deploy-panel: db blip"));
      expect(written().status).toBe("success");
    });

    it("a failed gate step carries the gate's notes next to the offender: a skipped route probe is not lost", async () => {
      // A literal private address: the route probe is refused (a note), never issued.
      mAppFindUnique.mockResolvedValue({ liveUrl: "http://10.0.0.5/" });
      setStuck([row(11 * MIN)]);
      relayWith(11 * MIN, [svc("backend"), restartingFrontend]);

      await recoverStuckDeploys();

      expect(written().status).toBe("failed");
      expect(gateEnv.fetch).not.toHaveBeenCalled();
      const output = writtenSteps().at(-2)!.output!;
      expect(output).toContain('service "frontend" is restarting');
      expect(output).toContain("route probe skipped");
    });

    it("asks the relay with a short per-request timeout so a slow relay cannot hold the gate for the 5 minute default", async () => {
      setStuck([row(3 * MIN)]);
      relayWith(3 * MIN, [svc("backend")]);

      await recoverStuckDeploys();

      const gatePoll = mRelay.mock.calls.map((c) => c[0]).filter((o) => o.path === "/api/apps/deploy-panel").at(-1);
      expect(gatePoll.timeoutMs).toBe(15_000);
    });

    describe("late relay proof (upgradeSelfDeploys)", () => {
      const MARK = "the panel is up, but this self-deploy is not verified: target not reached: x";
      const unverified = (startedMsAgo = 20 * MIN) => ({
        id: "g1",
        appId: "ag1",
        createdAt: ago(startedMsAgo),
        status: "interrupted",
        log: JSON.stringify([{ name: "startup-recovery", status: "failure", durationMs: 0, output: `Marked as interrupted; check failed: ${MARK}` }]),
        app: { name: "deploy-panel" },
        server: { id: "srv-a", relayUrl: "http://relay.example", relayToken: null },
      });

      it("a row the late proof would make success is failed, with the app unhealthy, when a service is crashlooping", async () => {
        setStuck([]);
        upgradeRows = [unverified()];
        relayWith(20 * MIN, [svc("backend"), restartingFrontend]);

        await recoverStuckDeploys();

        expect(written().status).toBe("failed");
        const steps = writtenSteps();
        expect(steps.at(-2)).toMatchObject({ name: "post-deploy health gate", status: "failure" });
        expect(steps.at(-1)).toMatchObject({ name: "startup-recovery", status: "failure" });
        expect(steps.at(-1)!.output).toContain("health gate failed");
        expect(lastCall(mAppUpdateMany)).toEqual({ where: { id: "ag1", deploys: { none: { status: "running" } } }, data: { status: "unhealthy", lastDeployAt: expect.any(Date) } });
      });

      it("inside the grace a not-clean gate leaves the row interrupted with no write at all (a miss other than 'no entry yet' ends interrupted at once)", async () => {
        setStuck([]);
        upgradeRows = [unverified(3 * MIN)];
        relayWith(3 * MIN, [svc("backend"), restartingFrontend]);

        await recoverStuckDeploys();

        expect(mUpdateMany).not.toHaveBeenCalled();
        expect(mAppUpdateMany).not.toHaveBeenCalled();
      });

      it("counts the grace from this process's start when that is later than the row's", async () => {
        bootedAgo(1 * MIN);
        setStuck([]);
        upgradeRows = [unverified(20 * MIN)];
        relayWith(20 * MIN, [svc("backend"), restartingFrontend]);

        await recoverStuckDeploys();

        expect(mUpdateMany).not.toHaveBeenCalled();
      });

      it("inside the grace a clean gate still upgrades the row", async () => {
        setStuck([]);
        upgradeRows = [unverified(3 * MIN)];
        relayWith(3 * MIN, [svc("backend"), svc("frontend")]);

        await recoverStuckDeploys();

        expect(written().status).toBe("success");
      });

      it("a healthy gate keeps the upgrade to success, with lastDeployAt", async () => {
        setStuck([]);
        upgradeRows = [unverified()];
        relayWith(20 * MIN, [svc("backend"), svc("frontend")]);

        await recoverStuckDeploys();

        expect(written().status).toBe("success");
        expect(lastCall(mAppUpdateMany).data).toEqual({ status: "healthy", lastDeployAt: expect.any(Date) });
      });
    });
  });

  describe("apps left on deploying with no running deploy (reconcileDeployingApps)", () => {
    const appRow = (deploys: Array<{ status: string; log?: string | null }>, over: Record<string, unknown> = {}) => ({
      id: "app1",
      name: "thd",
      deploys: deploys.map((d) => ({ log: null, ...d })),
      ...over,
    });
    const settled = () => lastCall(mAppUpdateMany);

    it("looks only at apps on deploying for longer than the stuck threshold that have no running deploy row, and runs when no deploy is stuck", async () => {
      setStuck([]);

      await recoverStuckDeploys();

      const query = mAppFindMany.mock.calls[0][0];
      expect(query.where.status).toBe("deploying");
      expect(query.where.deploys).toEqual({ none: { status: "running" } });
      const age = Date.now() - query.where.updatedAt.lt.getTime();
      expect(age).toBeGreaterThanOrEqual(2 * 60_000 - 1000);
      expect(age).toBeLessThan(2 * 60_000 + 5000);
      expect(query.select.deploys.where).toEqual({ status: { not: "running" } });
      expect(query.select.deploys.orderBy).toEqual({ createdAt: "desc" });
    });

    it("settles the app from its latest finished deploy: success is healthy", async () => {
      setStuck([]);
      mAppFindMany.mockResolvedValue([appRow([{ status: "success" }, { status: "failed" }])]);

      await recoverStuckDeploys();

      expect(settled()).toEqual({
      where: { id: "app1", status: "deploying", updatedAt: { lt: expect.any(Date) }, deploys: { none: { status: "running" } } },
      data: { status: "healthy" },
    });
    });

    it("failed is unhealthy", async () => {
      setStuck([]);
      mAppFindMany.mockResolvedValue([appRow([{ status: "failed", log: JSON.stringify([{ name: "up", status: "failure" }]) }])]);

      await recoverStuckDeploys();

      expect(settled().data.status).toBe("unhealthy");
    });

    it("failed after a healthy automatic rollback is healthy (the previous version serves)", async () => {
      setStuck([]);
      const log = JSON.stringify([
        { name: "up", status: "failure" },
        { name: "rollback: health check", status: "success" },
      ]);
      mAppFindMany.mockResolvedValue([appRow([{ status: "failed", log }])]);

      await recoverStuckDeploys();

      expect(settled().data.status).toBe("healthy");
    });

    it("interrupted and rolled_back are unknown: nothing shows how the app is doing", async () => {
      setStuck([]);
      mAppFindMany.mockResolvedValue([appRow([{ status: "interrupted" }, { status: "success" }])]);
      await recoverStuckDeploys();
      expect(settled().data.status).toBe("unknown");

      mAppFindMany.mockResolvedValue([appRow([{ status: "rolled_back" }])]);
      await recoverStuckDeploys();
      expect(settled().data.status).toBe("unknown");
    });

    it("an app with no finished deploy at all is unknown", async () => {
      setStuck([]);
      mAppFindMany.mockResolvedValue([appRow([])]);

      await recoverStuckDeploys();

      expect(settled().data.status).toBe("unknown");
    });

    it("skips a deploy the relay refused at preflight: it says nothing about the app", async () => {
      setStuck([]);
      const blocked = JSON.stringify([{ name: "env-preflight", kind: "preflight-check", status: "failure" }]);
      mAppFindMany.mockResolvedValue([appRow([{ status: "failed", log: blocked }, { status: "success" }])]);

      await recoverStuckDeploys();

      expect(settled().data.status).toBe("healthy");
    });

    it("compare-and-set on the query's own guards: a count of 0 is quiet, and one app failing does not stop the next", async () => {
      setStuck([]);
      mAppFindMany.mockResolvedValue([
        appRow([{ status: "success" }], { id: "bad", name: "bad-app" }),
        appRow([{ status: "success" }], { id: "good", name: "good-app" }),
      ]);
      mAppUpdateMany.mockImplementation((args: any) => {
        if (args.where.id === "bad") throw new Error("db blip");
        return Promise.resolve({ count: 0 });
      });

      await expect(recoverStuckDeploys()).resolves.toBeUndefined();

      expect(mAppUpdateMany.mock.calls.map((c) => c[0].where.id)).toEqual(["bad", "good"]);
      for (const c of mAppUpdateMany.mock.calls) {
        expect(c[0].where).toMatchObject({ status: "deploying", deploys: { none: { status: "running" } } });
        expect(c[0].where.updatedAt.lt).toBeInstanceOf(Date);
      }
    });

    it("a failing reconcile query does not fail the sweep that already finalized deploy rows", async () => {
      setStuck([makeStuckDeploy()]);
      mAppFindMany.mockRejectedValue(new Error("db down"));

      await expect(recoverStuckDeploys()).resolves.toBeUndefined();

      expect(mUpdateMany).toHaveBeenCalledOnce();
    });
  });

  describe("late relay proof upgrades an unverified self-deploy (upgradeSelfDeploys)", () => {
    const MIN = 60_000;
    const MARK = "the panel is up, but this self-deploy is not verified: target not reached: x";
    const unverified = (over: Record<string, unknown> = {}) => ({
      id: "self1",
      appId: "ap1",
      createdAt: new Date(Date.now() - 20 * MIN),
      status: "interrupted",
      log: JSON.stringify([{ name: "compose up", status: "success", durationMs: 5 }, { name: "startup-recovery", status: "failure", durationMs: 0, output: `Marked as interrupted; check failed: ${MARK}` }]),
      app: { name: "deploy-panel" },
      server: { id: "srv-a", relayUrl: "http://relay.example", relayToken: null },
      ...over,
    });
    const entryFor = (over: Record<string, unknown> = {}) =>
      relayDeployAfterStart({ deployId: "self1", createdAt: new Date(Date.now() - 10 * MIN).toISOString(), durationMs: 90_000, ...over });

    beforeEach(() => {
      setStuck([]);
    });

    it("asks only for interrupted rows of the panel's own app, inside one hour, that carry the marker", async () => {
      await recoverStuckDeploys();

      const q = mFindMany.mock.calls.map((c) => c[0]).find((a: any) => a.where.status === "interrupted");
      expect(q.where.app).toEqual({ name: "deploy-panel" });
      expect(q.where.log).toEqual({ contains: "this self-deploy is not verified" });
      const age = Date.now() - q.where.createdAt.gt.getTime();
      expect(age).toBeGreaterThan(59 * MIN);
      expect(age).toBeLessThan(61 * MIN);
    });

    it("uses PANEL_SELF_APP_NAME for the app it asks for", async () => {
      vi.stubEnv("PANEL_SELF_APP_NAME", "my-panel");
      try {
        await recoverStuckDeploys();
        const q = mFindMany.mock.calls.map((c) => c[0]).find((a: any) => a.where.status === "interrupted");
        expect(q.where.app).toEqual({ name: "my-panel" });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("upgrades the row to success with the entry's commits and duration once the id-matched success entry is there, appending a step", async () => {
      upgradeRows = [unverified()];
      mockRelay({ detail: { commit: "newsha2", recentDeploys: [entryFor()] } });

      await recoverStuckDeploys();

      const call = lastCall(mUpdateMany);
      expect(call.where).toEqual({ id: "self1", status: "interrupted", log: { contains: "this self-deploy is not verified" } });
      expect(call.data).toMatchObject({ status: "success", commitBefore: "oldsha1111111", commitAfter: "newsha2222222", duration: 90_000 });
      const steps = JSON.parse(call.data.log);
      expect(steps).toHaveLength(4);
      expect(steps.at(-2)).toMatchObject({ name: "post-deploy health gate", status: "success" });
      expect(steps.at(-1)).toMatchObject({ name: "startup-recovery", status: "success" });
      // The row just became a proven success, so the app write also records
      // the deploy (lastDeployAt), the finalizeDeploy rule.
      const appCall = lastCall(mAppUpdateMany);
      expect(appCall).toEqual({ where: { id: "ap1", deploys: { none: { status: "running" } } }, data: { status: "healthy", lastDeployAt: expect.any(Date) } });
    });

    it("leaves the row alone while the relay still has no proving entry (no entry, failed entry, later deploy row)", async () => {
      upgradeRows = [unverified()];
      mockRelay({ detail: { commit: "oldsha1", recentDeploys: [] } });
      await recoverStuckDeploys();
      mockRelay({ detail: { commit: "newsha2", recentDeploys: [entryFor({ status: "failed" })] } });
      await recoverStuckDeploys();
      mockRelay({ detail: { commit: "newsha2", recentDeploys: [entryFor()] } });
      mDeployFindFirst.mockImplementation(async (args: any) => (args.where.createdAt?.gt ? { id: "later" } : null));
      await recoverStuckDeploys();

      expect(mUpdateMany).not.toHaveBeenCalled();
      expect(mAppUpdateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: { status: "healthy" } }));
    });

    it("compare-and-set: a row another path already moved is not followed by an app write", async () => {
      upgradeRows = [unverified()];
      mockRelay({ detail: { commit: "newsha2", recentDeploys: [entryFor()] } });
      mUpdateMany.mockResolvedValue({ count: 0 });

      await recoverStuckDeploys();

      expect(mAppUpdateMany).not.toHaveBeenCalled();
    });

    it("an id-less relay with one correlated success entry does not upgrade the row (a later non-panel deploy would be indistinguishable)", async () => {
      upgradeRows = [unverified()];
      const entry = entryFor();
      delete (entry as Record<string, unknown>).deployId;
      mockRelay({ detail: { commit: "newsha2", recentDeploys: [entry] } });

      await recoverStuckDeploys();

      expect(mUpdateMany).not.toHaveBeenCalled();
      expect(mAppUpdateMany).not.toHaveBeenCalled();
    });

    it("the marker is read from the last startup-recovery step only: relay step output holding the same text, or a note without it, does not qualify", async () => {
      const note = (output: string) => ({ name: "startup-recovery", status: "failure", durationMs: 0, output });
      upgradeRows = [
        unverified({ id: "a", log: JSON.stringify([{ name: "up", status: "failure", durationMs: 1, output: MARK }, note("Marked as interrupted; check failed: relay preflight did not pass")]) }),
        unverified({ id: "b", log: JSON.stringify([{ name: "up", status: "failure", output: MARK }]) }),
        unverified({ id: "c", log: "not json " + MARK }),
        unverified({ id: "d", log: JSON.stringify([note(MARK), note("Marked as interrupted; check failed: relay preflight did not pass")]) }),
      ];
      mockRelay({ detail: { commit: "newsha2", recentDeploys: [entryFor()] } });

      await recoverStuckDeploys();

      expect(mRelay).not.toHaveBeenCalled();
      expect(mUpdateMany).not.toHaveBeenCalled();
    });

    it("never asks the relay for a row of another app, or a server without a relay", async () => {
      upgradeRows = [unverified({ app: { name: "other-app" } }), unverified({ id: "self2", server: { id: "s", relayUrl: null, relayToken: null } })];
      mockRelay({ detail: { commit: "newsha2", recentDeploys: [entryFor()] } });

      await recoverStuckDeploys();

      expect(mRelay).not.toHaveBeenCalled();
      expect(mUpdateMany).not.toHaveBeenCalled();
    });
  });
});
