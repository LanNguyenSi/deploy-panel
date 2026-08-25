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
import { recoverBrokenDeploy, activeDeployIds } from "../src/lib/deploy-recovery.js";

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

// recoverBrokenDeploy self-registers in activeDeployIds (try/finally around
// its own body) independently of whatever the caller already did, so ANY
// caller gets the stuck-sweep exclusion for the full duration of its own
// health-check polling, not just callers that remembered to register
// beforehand. This is the REAL recoverBrokenDeploy (not a mock, unlike the
// route-level "activeDeployIds registration" tests in
// apps-rollback-route.test.ts / v1-api.test.ts, which stub recoverBrokenDeploy
// entirely and so cannot exercise this self-registration at all): it pins
// the add/finally-delete pair directly against a controllable
// verifyDeployHealth, on both the resolve and the reject path. Deleting the
// try/finally around recoverBrokenDeployBody entirely (a mutant that
// survived the round-2 suite) would make the id vanish from
// activeDeployIds the instant recoverBrokenDeploy is called, defeating the
// stuck-sweep exclusion for its whole ~60s polling window; this test fails
// immediately on that mutant since the id would never be present at all.
describe("recoverBrokenDeploy: self-registration in activeDeployIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeDeployIds.clear();
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
    expect(activeDeployIds.has("d-resolve")).toBe(true);

    settleGate({ healthy: true });
    await recoverPromise;

    expect(activeDeployIds.has("d-resolve")).toBe(false);
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
    expect(activeDeployIds.has("d-reject")).toBe(true);

    settleGate();
    await expect(recoverPromise).rejects.toThrow("relay unreachable");

    expect(activeDeployIds.has("d-reject")).toBe(false);
  });
});
