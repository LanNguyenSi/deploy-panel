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
import { finalizeDeploy } from "../src/lib/stream-deploy.js";

const mDeployUpdate = (prisma.deploy as any).update as ReturnType<typeof vi.fn>;
const mAppUpdate = (prisma.app as any).update as ReturnType<typeof vi.fn>;
const mGate = verifyDeployHealth as unknown as ReturnType<typeof vi.fn>;

const base = {
  deployId: "d1",
  appId: "a1",
  serverId: "srv-a",
  appName: "thd",
  steps: [{ name: "compose up", status: "success" }],
};

const lastCall = (m: ReturnType<typeof vi.fn>) => m.mock.calls[m.mock.calls.length - 1][0];

describe("finalizeDeploy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes success/healthy when the relay succeeded AND the gate passes", async () => {
    mGate.mockResolvedValue({ healthy: true });

    await finalizeDeploy({ ...base, relaySuccess: true });

    expect(mGate).toHaveBeenCalledOnce();
    expect(lastCall(mDeployUpdate).data.status).toBe("success");
    expect(lastCall(mAppUpdate).data.status).toBe("healthy");
    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps.at(-1)).toMatchObject({ name: "post-deploy health gate", status: "success" });
  });

  it("DOWNGRADES a relay-success to failed/unhealthy when the gate fails, recording the reason", async () => {
    mGate.mockResolvedValue({ healthy: false, reason: 'service "frontend" is restarting (Restarting (1) 3s ago)' });

    await finalizeDeploy({ ...base, relaySuccess: true });

    // The relay said success; the gate overrides it.
    expect(lastCall(mDeployUpdate).data.status).toBe("failed");
    expect(lastCall(mAppUpdate).data.status).toBe("unhealthy");
    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps.at(-1)).toMatchObject({ name: "post-deploy health gate", status: "failure" });
    expect(steps.at(-1).output).toContain('service "frontend" is restarting');
  });

  it("writes failed/unhealthy without running the gate when the relay already failed", async () => {
    await finalizeDeploy({ ...base, relaySuccess: false });

    expect(mGate).not.toHaveBeenCalled();
    expect(lastCall(mDeployUpdate).data.status).toBe("failed");
    expect(lastCall(mAppUpdate).data.status).toBe("unhealthy");
  });

  it("passes the app's liveUrl through to the gate", async () => {
    mGate.mockResolvedValue({ healthy: true });

    await finalizeDeploy({ ...base, relaySuccess: true });

    expect(mGate).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv-a", appName: "thd", liveUrl: "https://status.opentriologue.ai/" }),
    );
  });

  it("surfaces gate notes (e.g. an SSRF-refused route probe) in the gate step output", async () => {
    mGate.mockResolvedValue({ healthy: true, notes: ["route probe skipped: 10.0.0.5 is a non-public address"] });

    await finalizeDeploy({ ...base, relaySuccess: true });

    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps.at(-1).output).toContain("route probe skipped");
    expect(lastCall(mAppUpdate).data.status).toBe("healthy"); // a note does not fail the deploy
  });

  it("qualifies the step wording for an unconfirmed optimistic pass instead of claiming a healthy run state", async () => {
    mGate.mockResolvedValue({
      healthy: true,
      unconfirmed: true,
      notes: ['health of "worker" still "starting" after 13 polls; passing optimistically'],
    });

    await finalizeDeploy({ ...base, relaySuccess: true });

    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps.at(-1).status).toBe("success"); // still a pass -- wording changes, outcome does not
    expect(steps.at(-1).output).toContain("Passed optimistically without positive health confirmation");
    expect(steps.at(-1).output).not.toContain("Containers in a healthy run state");
    expect(steps.at(-1).output).toContain('still "starting"');
    expect(lastCall(mAppUpdate).data.status).toBe("healthy");
  });

  it("forwards commitBefore/commitAfter/duration to the deploy row", async () => {
    mGate.mockResolvedValue({ healthy: true });

    await finalizeDeploy({
      ...base,
      relaySuccess: true,
      commitBefore: "aaaa111",
      commitAfter: "bbbb222",
      duration: 42_000,
    });

    const data = lastCall(mDeployUpdate).data;
    expect(data).toMatchObject({ commitBefore: "aaaa111", commitAfter: "bbbb222", duration: 42_000 });
  });
});
