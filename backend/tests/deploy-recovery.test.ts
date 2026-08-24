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
import { recoverBrokenDeploy } from "../src/lib/deploy-recovery.js";

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
