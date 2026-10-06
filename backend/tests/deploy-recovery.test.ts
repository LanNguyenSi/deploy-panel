import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    app: {
      findUnique: vi.fn().mockResolvedValue({ liveUrl: "https://status.opentriologue.ai/" }),
      update: vi.fn().mockResolvedValue({}),
    },
    deploy: {
      findUnique: vi.fn().mockResolvedValue({ log: null }),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("../src/lib/relay.js", () => ({
  relayRequest: vi.fn(),
}));

vi.mock("../src/lib/post-deploy-gate.js", () => ({
  verifyDeployHealth: vi.fn(),
}));

import { prisma } from "../src/lib/prisma.js";
import { verifyDeployHealth } from "../src/lib/post-deploy-gate.js";
import { relayRequest } from "../src/lib/relay.js";
import {
  recoverBrokenDeploy,
  isActiveDeploy,
  clearActiveDeploys,
  getActiveDeployRefCount,
  registerActiveDeploy,
  releaseActiveDeploy,
} from "../src/lib/deploy-recovery.js";

const mDeployFindUnique = (prisma.deploy as any).findUnique as ReturnType<typeof vi.fn>;
const mDeployUpdate = (prisma.deploy as any).update as ReturnType<typeof vi.fn>;
const mAppUpdate = (prisma.app as any).update as ReturnType<typeof vi.fn>;
const mDeployFindFirst = (prisma.deploy as any).findFirst as ReturnType<typeof vi.fn>;
const mGate = verifyDeployHealth as unknown as ReturnType<typeof vi.fn>;
const mRelay = relayRequest as unknown as ReturnType<typeof vi.fn>;

// The panel stamps the Deploy row before it calls the relay; the relay's own
// history entry for that deploy ends later and carries a positive duration.
const DEPLOY_START = new Date("2026-10-06T10:00:00.000Z");
const HEAD = "abc1234";

const relayEntry = (over: Record<string, unknown> = {}) => ({
  status: "success",
  commitAfter: HEAD,
  createdAt: new Date(DEPLOY_START.getTime() + 150_000).toISOString(),
  durationMs: 140_000,
  triggeredBy: "api",
  ...over,
});

const mockRelayDetail = (detail: { commit?: string; recentDeploys?: Array<Record<string, unknown>> }) => {
  mRelay.mockResolvedValue({ app: { name: "thd", containers: "[]", ...detail } });
};

/** The relay proves this deploy ran: one matching success entry whose commitAfter is HEAD. */
const mockTargetReached = () => mockRelayDetail({ commit: HEAD, recentDeploys: [relayEntry()] });

const lastCall = (m: ReturnType<typeof vi.fn>) => m.mock.calls[m.mock.calls.length - 1][0];

describe("recoverBrokenDeploy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mDeployFindUnique.mockResolvedValue({ log: null, createdAt: DEPLOY_START });
    mDeployFindFirst.mockResolvedValue(null);
    mockTargetReached();
  });

  it("marks the recovered deploy success/healthy when the gate confirms health and the relay proves the target was reached", async () => {
    mGate.mockResolvedValue({ healthy: true });

    await recoverBrokenDeploy("d1", "a1", "srv-a", "thd", "socket hang up");

    expect(lastCall(mDeployUpdate).data.status).toBe("success");
    expect(lastCall(mAppUpdate).data.status).toBe("healthy");
  });

  it("appends to the deploy's existing log instead of replacing it", async () => {
    mDeployFindUnique.mockResolvedValue({
      log: JSON.stringify([{ name: "provision-secrets", status: "success", durationMs: 0 }]),
      createdAt: DEPLOY_START,
    });
    mGate.mockResolvedValue({ healthy: true });

    await recoverBrokenDeploy("d1", "a1", "srv-a", "thd", "socket hang up");

    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps[0]).toMatchObject({ name: "provision-secrets", status: "success" });
    expect(steps.at(-1)).toMatchObject({ name: "recovery", status: "success" });
  });

  it("falls back to an empty accumulated-steps array when the existing log is unparseable, instead of throwing", async () => {
    mDeployFindUnique.mockResolvedValue({ log: "not json", createdAt: DEPLOY_START });
    mGate.mockResolvedValue({ healthy: true });

    await recoverBrokenDeploy("d1", "a1", "srv-a", "thd", "socket hang up");

    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps).toEqual([expect.objectContaining({ name: "recovery", status: "success" })]);
  });

  it("refuses the optimistic success verdict and records the deploy failed when the accumulated log already contains a rollback step, even though the gate confirms health", async () => {
    mDeployFindUnique.mockResolvedValue({
      log: JSON.stringify([
        { name: "health check", status: "failure", durationMs: 0, output: "HTTP_STATUS=500" },
        { name: "rollback: compose up", status: "success", durationMs: 300 },
      ]),
    });
    // The probe genuinely finds the app healthy — it's the OLD version,
    // restored by rollback, that's answering.
    mGate.mockResolvedValue({ healthy: true });

    await recoverBrokenDeploy("d1", "a1", "srv-a", "thd", "socket hang up");

    expect(lastCall(mDeployUpdate).data.status).toBe("failed");
    // The app itself really is up — just not because THIS deploy succeeded.
    expect(lastCall(mAppUpdate).data.status).toBe("healthy");
    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps.some((s: any) => s.name === "rollback: compose up")).toBe(true);
    expect(steps.at(-1).output).toContain("rollback");
  });

  it("refuses the optimistic success verdict when the accumulated log already contains any failed step, even without a rollback step", async () => {
    mDeployFindUnique.mockResolvedValue({
      log: JSON.stringify([{ name: "compose up", status: "failure", durationMs: 0, output: "exit 1" }]),
    });
    mGate.mockResolvedValue({ healthy: true });

    await recoverBrokenDeploy("d1", "a1", "srv-a", "thd", "socket hang up");

    expect(lastCall(mDeployUpdate).data.status).toBe("failed");
  });

  it("marks the recovered deploy failed/unhealthy when a container is crashlooping, recording the reason", async () => {
    mGate.mockResolvedValue({ healthy: false, reason: 'service "frontend" is restarting (Restarting (1) 3s ago)' });

    await recoverBrokenDeploy("d1", "a1", "srv-a", "thd", "socket hang up");

    expect(lastCall(mDeployUpdate).data.status).toBe("failed");
    expect(lastCall(mAppUpdate).data.status).toBe("unhealthy");
    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps.at(-1).output).toContain('service "frontend" is restarting');
  });

  it("surfaces gate notes (e.g. an SSRF-refused route probe) in the recovery step output", async () => {
    mGate.mockResolvedValue({ healthy: true, notes: ["route probe skipped: 10.0.0.5 is a non-public address"] });

    await recoverBrokenDeploy("d1", "a1", "srv-a", "thd", "socket hang up");

    expect(lastCall(mDeployUpdate).data.status).toBe("success");
    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps.at(-1).output).toContain("route probe skipped");
  });

  it("runs the gate fail-closed (requireHealthyEvidence) and passes the app's liveUrl", async () => {
    mGate.mockResolvedValue({ healthy: true });

    await recoverBrokenDeploy("d1", "a1", "srv-a", "thd", "socket hang up");

    expect(mGate).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "srv-a",
        appName: "thd",
        liveUrl: "https://status.opentriologue.ai/",
        requireHealthyEvidence: true,
      }),
    );
  });
});

// A healthy probe is also true when the relay was cut off before the git
// pull: the old containers keep running, so the deploy never happened. The
// connection-lost recovery therefore applies the same target check as the
// stuck sweep (see startup-recovery.test.ts for the check's own cases): no
// later panel row for the app, and exactly one matching relay success entry
// whose commitAfter is the repo HEAD. These tests pin that wiring.
describe("recoverBrokenDeploy: a healthy probe needs proof the target was reached", () => {
  const OLD_HEAD = "0ld1234";

  beforeEach(() => {
    vi.clearAllMocks();
    mDeployFindUnique.mockResolvedValue({ log: null, createdAt: DEPLOY_START });
    mDeployFindFirst.mockResolvedValue(null);
    mGate.mockResolvedValue({ healthy: true });
  });

  it("incident shape: relay stopped before git pull, old containers healthy, no relay entry since the start -> interrupted with a named failed check", async () => {
    // The relay's only history entry predates the deploy: the old commit still runs.
    mockRelayDetail({
      commit: OLD_HEAD,
      recentDeploys: [relayEntry({ createdAt: new Date(DEPLOY_START.getTime() - 3_600_000).toISOString(), commitAfter: OLD_HEAD })],
    });

    await recoverBrokenDeploy("d1", "a1", "srv-a", "thd", "socket hang up");

    expect(lastCall(mDeployUpdate).data.status).toBe("interrupted");
    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps.at(-1)).toMatchObject({ name: "recovery", status: "failure" });
    expect(steps.at(-1).output).toContain("check failed: target not reached: the relay recorded no deploy since");
    expect(steps.at(-1).output).toContain("socket hang up");
    // The old version really is up: app card healthy, but no deploy happened.
    expect(lastCall(mAppUpdate).data).toEqual({ status: "healthy" });
    expect(mRelay).toHaveBeenCalledWith(expect.objectContaining({ serverId: "srv-a", path: "/api/apps/thd" }));
  });

  it("real success path: one matching relay success entry whose commitAfter is HEAD -> success, lastDeployAt moves", async () => {
    mockTargetReached();

    await recoverBrokenDeploy("d1", "a1", "srv-a", "thd", "socket hang up");

    expect(lastCall(mDeployUpdate).data.status).toBe("success");
    expect(lastCall(mAppUpdate).data.status).toBe("healthy");
    expect(lastCall(mAppUpdate).data.lastDeployAt).toBeInstanceOf(Date);
  });

  it("a relay success entry whose commitAfter is not the repo HEAD -> interrupted", async () => {
    mockRelayDetail({ commit: OLD_HEAD, recentDeploys: [relayEntry({ commitAfter: HEAD })] });

    await recoverBrokenDeploy("d1", "a1", "srv-a", "thd", "socket hang up");

    expect(lastCall(mDeployUpdate).data.status).toBe("interrupted");
    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps.at(-1).output).toContain("does not match the target commit");
  });

  it("a relay entry that ended failed -> interrupted", async () => {
    mockRelayDetail({ commit: HEAD, recentDeploys: [relayEntry({ status: "failed" })] });

    await recoverBrokenDeploy("d1", "a1", "srv-a", "thd", "socket hang up");

    expect(lastCall(mDeployUpdate).data.status).toBe("interrupted");
  });

  it("another panel deploy row of the app created after this one -> interrupted, naming that row, and the relay is not asked", async () => {
    mockTargetReached();
    mDeployFindFirst.mockResolvedValue({ id: "later-deploy" });

    await recoverBrokenDeploy("d1", "a1", "srv-a", "thd", "socket hang up");

    expect(lastCall(mDeployUpdate).data.status).toBe("interrupted");
    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps.at(-1).output).toContain("later-deploy");
    expect(mRelay).not.toHaveBeenCalled();
    expect(mDeployFindFirst).toHaveBeenCalledWith({
      where: { appId: "a1", id: { not: "d1" }, createdAt: { gt: DEPLOY_START } },
      select: { id: true },
    });
  });

  it("relay unreachable for the history lookup -> interrupted, not success", async () => {
    mRelay.mockRejectedValue(new Error("ECONNREFUSED"));

    await recoverBrokenDeploy("d1", "a1", "srv-a", "thd", "socket hang up");

    expect(lastCall(mDeployUpdate).data.status).toBe("interrupted");
    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps.at(-1).output).toContain("check failed: relay unreachable or app lookup failed");
  });

  it("a deploy row whose start time cannot be read -> interrupted (the check cannot run), the relay is not asked", async () => {
    mockTargetReached();
    mDeployFindUnique.mockResolvedValue({ log: null });

    await recoverBrokenDeploy("d1", "a1", "srv-a", "thd", "socket hang up");

    expect(lastCall(mDeployUpdate).data.status).toBe("interrupted");
    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps.at(-1).output).toContain("start time could not be read");
    expect(mRelay).not.toHaveBeenCalled();
  });

  it("an unhealthy verdict stays failed and never reaches the target check", async () => {
    mGate.mockResolvedValue({ healthy: false, reason: "service web is restarting" });

    await recoverBrokenDeploy("d1", "a1", "srv-a", "thd", "socket hang up");

    expect(lastCall(mDeployUpdate).data.status).toBe("failed");
    expect(mRelay).not.toHaveBeenCalled();
    expect(mDeployFindFirst).not.toHaveBeenCalled();
  });

  it("a healthy probe over a log that already shows a rollback stays failed and never reaches the target check", async () => {
    mDeployFindUnique.mockResolvedValue({
      log: JSON.stringify([{ name: "rollback: compose up", status: "success", durationMs: 300 }]),
      createdAt: DEPLOY_START,
    });

    await recoverBrokenDeploy("d1", "a1", "srv-a", "thd", "socket hang up");

    expect(lastCall(mDeployUpdate).data.status).toBe("failed");
    expect(mRelay).not.toHaveBeenCalled();
  });

  it("kind rollback keeps the health-only verdict: the relay history is not consulted (a rollback entry has no duration the check could accept)", async () => {
    mRelay.mockRejectedValue(new Error("must not be called"));

    await recoverBrokenDeploy("d1", "a1", "srv-a", "thd", "socket hang up", "rollback");

    expect(lastCall(mDeployUpdate).data.status).toBe("success");
    expect(mRelay).not.toHaveBeenCalled();
    expect(mDeployFindFirst).not.toHaveBeenCalled();
  });
});

// recoverBrokenDeploy self-registers in the active-deploy registry
// (try/finally around its own body) independently of whatever the caller
// already did, so ANY caller gets the stuck-sweep exclusion for the full
// duration of its own health-check polling, not just callers that
// remembered to register beforehand. This is the REAL recoverBrokenDeploy
// (not a mock, unlike the route-level "active-deploy registration" tests
// in apps-rollback-route.test.ts / v1-api.test.ts, which stub
// recoverBrokenDeploy entirely and so cannot exercise this self-registration
// at all): it pins the register/finally-release pair directly against a
// controllable verifyDeployHealth, on both the resolve and the reject path.
// Deleting the try/finally around recoverBrokenDeployBody entirely (a
// mutant that survived the round-2 suite) would make the id vanish from the
// registry the instant recoverBrokenDeploy is called, defeating the
// stuck-sweep exclusion for its whole ~60s polling window; this test fails
// immediately on that mutant since the id would never be present at all.
describe("recoverBrokenDeploy: self-registration in the active-deploy registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearActiveDeploys();
    mDeployFindUnique.mockResolvedValue({ log: null });
  });

  it("is present while the health check is pending and absent after it resolves", async () => {
    let settleGate!: (v: { healthy: boolean }) => void;
    mGate.mockReturnValue(
      new Promise((resolve) => {
        settleGate = resolve;
      }),
    );

    const recoverPromise = recoverBrokenDeploy("d-resolve", "a1", "srv-a", "thd", "socket hang up");

    await vi.waitFor(() => expect(mGate).toHaveBeenCalledOnce());
    expect(isActiveDeploy("d-resolve")).toBe(true);

    settleGate({ healthy: true });
    await recoverPromise;

    expect(isActiveDeploy("d-resolve")).toBe(false);
  });

  it("is present while the health check is pending and absent after it rejects (the finally still runs)", async () => {
    let settleGate!: () => void;
    mGate.mockReturnValue(
      new Promise((_resolve, reject) => {
        settleGate = () => reject(new Error("relay unreachable"));
      }),
    );

    const recoverPromise = recoverBrokenDeploy("d-reject", "a1", "srv-a", "thd", "socket hang up");
    // deploy-recovery.ts's own async body doesn't catch a verifyDeployHealth
    // rejection, so recoverPromise itself rejects too; observe it here so
    // that isn't a test artifact (the ordering assertions below are what
    // this test actually pins).
    recoverPromise.catch(() => {});

    await vi.waitFor(() => expect(mGate).toHaveBeenCalledOnce());
    expect(isActiveDeploy("d-reject")).toBe(true);

    settleGate();
    await expect(recoverPromise).rejects.toThrow("relay unreachable");

    expect(isActiveDeploy("d-reject")).toBe(false);
  });
});

// AC2: a caller (e.g. one of the rollback routes) registers a deployId
// before handing it to recoverBrokenDeploy, which registers the SAME id
// again on its own. The refcount must keep the id active until BOTH
// registrations have released, in either release order — this is what
// makes the routes' plain unconditional try/finally safe without a
// `recovering` flag: the caller's own release (its finally running once
// the handoff is dispatched) must not remove recoverBrokenDeploy's still-
// pending hold on the same id.
describe("nested register/release: a caller's own hold and recoverBrokenDeploy's self-registration are independent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearActiveDeploys();
    mDeployFindUnique.mockResolvedValue({ log: null });
  });

  it("keeps the id active after the caller releases its own hold, until recoverBrokenDeploy releases its own", async () => {
    let settleGate!: (v: { healthy: boolean }) => void;
    mGate.mockReturnValue(
      new Promise((resolve) => {
        settleGate = resolve;
      }),
    );

    // Simulates a route registering before the handoff (apps.ts/v1.ts).
    registerActiveDeploy("nested-1");
    expect(isActiveDeploy("nested-1")).toBe(true);

    // Fire-and-forget, exactly like apps.ts/v1.ts: the caller does not
    // await recoverBrokenDeploy before releasing its own hold, it releases
    // in the SAME synchronous turn as the hand-off (its own finally running
    // right after the call, not after any await). Asserting and releasing
    // here — immediately after the call, before the vi.waitFor below —
    // pins that real ordering. Moving this block after vi.waitFor would
    // hide a regression where recoverBrokenDeploy's own registerActiveDeploy
    // call stops being the first (synchronous) statement in its body: an
    // await inserted ahead of it lets the caller's release run before
    // recoverBrokenDeploy's own registration ever lands, so the id would
    // briefly carry ZERO holds while recovery is still genuinely in flight
    // — a window vi.waitFor's own awaiting would paper over.
    const recoverPromise = recoverBrokenDeploy("nested-1", "a1", "srv-a", "thd", "socket hang up");
    // Both the caller's own registration and recoverBrokenDeploy's own are
    // held at this point.
    expect(getActiveDeployRefCount("nested-1")).toBe(2);

    // The caller's own finally runs (route handler returning its HTTP
    // response) while recoverBrokenDeploy is still polling health.
    releaseActiveDeploy("nested-1");
    expect(isActiveDeploy("nested-1")).toBe(true); // recoverBrokenDeploy's own hold keeps it registered

    await vi.waitFor(() => expect(mGate).toHaveBeenCalledOnce());

    settleGate({ healthy: true });
    await recoverPromise;

    expect(isActiveDeploy("nested-1")).toBe(false);
  });
});

// AC4: releaseActiveDeploy must never push a refcount negative (a stray
// double release must not corrupt bookkeeping for some OTHER, unrelated
// registration that happens to reuse the same id later), and a forgotten
// release must be visible as a nonzero refcount rather than silently
// vanishing.
describe("releaseActiveDeploy: double release and a missing release", () => {
  beforeEach(() => {
    clearActiveDeploys();
  });

  it("a double release does not go negative, and a later unrelated registration for the same id is unaffected", () => {
    registerActiveDeploy("leak-1");
    registerActiveDeploy("leak-1"); // a second, independent hold
    expect(getActiveDeployRefCount("leak-1")).toBe(2);

    releaseActiveDeploy("leak-1");
    releaseActiveDeploy("leak-1");
    releaseActiveDeploy("leak-1"); // one release beyond what was ever registered
    expect(getActiveDeployRefCount("leak-1")).toBe(0);
    expect(isActiveDeploy("leak-1")).toBe(false);

    registerActiveDeploy("leak-1");
    expect(getActiveDeployRefCount("leak-1")).toBe(1);
  });

  it("a missing release is visible as a nonzero refcount instead of silently disappearing", () => {
    registerActiveDeploy("leak-2");
    registerActiveDeploy("leak-2");
    releaseActiveDeploy("leak-2"); // only one of the two holds is ever released

    expect(getActiveDeployRefCount("leak-2")).toBe(1);
    expect(isActiveDeploy("leak-2")).toBe(true);
  });
});
