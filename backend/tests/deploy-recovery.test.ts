import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    app: {
      findUnique: vi.fn().mockResolvedValue({ liveUrl: "https://status.opentriologue.ai/" }),
      update: vi.fn().mockResolvedValue({}),
    },
    deploy: { update: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../src/lib/post-deploy-gate.js", () => ({
  verifyDeployHealth: vi.fn(),
}));

import { prisma } from "../src/lib/prisma.js";
import { verifyDeployHealth } from "../src/lib/post-deploy-gate.js";
import { recoverBrokenDeploy } from "../src/lib/deploy-recovery.js";

const mDeployUpdate = (prisma.deploy as any).update as ReturnType<typeof vi.fn>;
const mAppUpdate = (prisma.app as any).update as ReturnType<typeof vi.fn>;
const mGate = verifyDeployHealth as unknown as ReturnType<typeof vi.fn>;

const lastCall = (m: ReturnType<typeof vi.fn>) => m.mock.calls[m.mock.calls.length - 1][0];

describe("recoverBrokenDeploy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks the recovered deploy success/healthy when the gate confirms health", async () => {
    mGate.mockResolvedValue({ healthy: true });

    await recoverBrokenDeploy("d1", "a1", "srv-a", "thd", "socket hang up");

    expect(lastCall(mDeployUpdate).data.status).toBe("success");
    expect(lastCall(mAppUpdate).data.status).toBe("healthy");
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
