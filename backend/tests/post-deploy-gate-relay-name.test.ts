import { describe, expect, it, vi, beforeEach } from "vitest";
import { verifyDeployHealth } from "../src/lib/post-deploy-gate.js";

// The post-deploy health gate (lib/post-deploy-gate.ts) reads container
// state through relayAppPath (lib/relay-path.ts). A name the guard refuses
// throws BEFORE the relay request, and the gate's per-poll catch turns that
// into "could not inspect this poll", the same posture as an unreachable
// relay: optimistic callers keep their pre-gate verdict, strict callers see
// nothing confirmed. It must never crash the gate and never build a
// traversal-shaped app URL.

describe("verifyDeployHealth with a name the relay path guard refuses", () => {
  beforeEach(() => vi.clearAllMocks());

  const refusedOpts = (relayRequestImpl: ReturnType<typeof vi.fn>, extra = {}) => ({
    serverId: "srv-a",
    appName: "a.b",
    liveUrl: null,
    attempts: 1,
    sleepImpl: () => Promise.resolve(),
    relayRequestImpl,
    ...extra,
  });

  it("optimistic: passes as uninspected with NO relay request", async () => {
    const relayRequestImpl = vi.fn().mockResolvedValue({ app: { containers: "[]" } });
    const verdict = await verifyDeployHealth(refusedOpts(relayRequestImpl));
    expect(relayRequestImpl).not.toHaveBeenCalled();
    // Not inspected is not a bad signal (absence of bad news, optimistic mode).
    expect(verdict.healthy).toBe(true);
    expect(verdict.reason).toBeUndefined();
  });

  it("strict (recovery posture): reports not-confirmed naming the app, with NO relay request", async () => {
    const relayRequestImpl = vi.fn().mockResolvedValue({ app: { containers: "[]" } });
    const verdict = await verifyDeployHealth(refusedOpts(relayRequestImpl, { requireHealthyEvidence: true }));
    expect(relayRequestImpl).not.toHaveBeenCalled();
    expect(verdict.healthy).toBe(false);
    expect(verdict.reason).toContain('could not reach the relay to confirm "a.b"');
  });

  it("still queries the relay for an accepted name (contrast)", async () => {
    const relayRequestImpl = vi.fn().mockResolvedValue({
      app: { containers: JSON.stringify([{ Service: "web", State: "running", Health: "healthy", ExitCode: 0, Status: "Up" }]) },
    });
    const verdict = await verifyDeployHealth({
      serverId: "srv-a",
      appName: "_bad",
      liveUrl: null,
      attempts: 1,
      sleepImpl: () => Promise.resolve(),
      relayRequestImpl,
    });
    expect(relayRequestImpl).toHaveBeenCalledTimes(1);
    expect(relayRequestImpl.mock.calls[0][0].path).toBe("/api/apps/_bad");
    expect(verdict.healthy).toBe(true);
  });
});
