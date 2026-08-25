import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    app: {
      findUnique: vi.fn().mockResolvedValue({ liveUrl: "https://status.opentriologue.ai/" }),
      update: vi.fn().mockResolvedValue({}),
    },
    deploy: {
      findUnique: vi.fn().mockResolvedValue({ log: null }),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("../src/lib/post-deploy-gate.js", () => ({
  verifyDeployHealth: vi.fn(),
}));

import { prisma } from "../src/lib/prisma.js";
import { verifyDeployHealth } from "../src/lib/post-deploy-gate.js";
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
const mGate = verifyDeployHealth as unknown as ReturnType<typeof vi.fn>;

const lastCall = (m: ReturnType<typeof vi.fn>) => m.mock.calls[m.mock.calls.length - 1][0];

describe("recoverBrokenDeploy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mDeployFindUnique.mockResolvedValue({ log: null });
  });

  it("marks the recovered deploy success/healthy when the gate confirms health", async () => {
    mGate.mockResolvedValue({ healthy: true });

    await recoverBrokenDeploy("d1", "a1", "srv-a", "thd", "socket hang up");

    expect(lastCall(mDeployUpdate).data.status).toBe("success");
    expect(lastCall(mAppUpdate).data.status).toBe("healthy");
  });

  it("appends to the deploy's existing log instead of replacing it", async () => {
    mDeployFindUnique.mockResolvedValue({
      log: JSON.stringify([{ name: "provision-secrets", status: "success", durationMs: 0 }]),
    });
    mGate.mockResolvedValue({ healthy: true });

    await recoverBrokenDeploy("d1", "a1", "srv-a", "thd", "socket hang up");

    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps[0]).toMatchObject({ name: "provision-secrets", status: "success" });
    expect(steps.at(-1)).toMatchObject({ name: "recovery", status: "success" });
  });

  it("falls back to an empty accumulated-steps array when the existing log is unparseable, instead of throwing", async () => {
    mDeployFindUnique.mockResolvedValue({ log: "not json" });
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
