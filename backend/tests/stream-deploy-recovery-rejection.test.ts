import { describe, expect, it, vi, beforeEach } from "vitest";

// streamDeploy's catch used to call recoverBrokenDeploy fire-and-forget (no
// await, no .catch). If recoverBrokenDeploy itself rejected (before any of
// its own internal prisma calls, which each already have a trailing
// .catch), that became an unhandled rejection AND left the deploy record on
// "running" forever, since nothing ever finalized it. Now the call is
// awaited with its own .catch, so a rejection there is logged and swallowed
// instead of propagating, and the deploy id is still removed from
// activeDeployIds (see the `finally` in stream-deploy.ts), so the periodic
// stuck-sweep (scheduler-stuck-sweep.test.ts) can still reclaim the
// now-orphaned record later. See deploy-panel#130.

vi.mock("../src/lib/deploy-recovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/deploy-recovery.js")>();
  return {
    ...actual,
    recoverBrokenDeploy: vi.fn().mockRejectedValue(new Error("recovery boom")),
  };
});

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    app: { findUnique: vi.fn().mockResolvedValue({ requiredEnvKeys: [], liveUrl: null }) },
    deploy: {
      findUnique: vi.fn().mockResolvedValue({ status: "running", log: null }),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("../src/lib/provision-secrets.js", () => ({
  provisionAndCheckAppSecrets: vi.fn().mockResolvedValue({ provisionedKeys: [], wrote: false, missing: [] }),
}));

import { streamDeploy } from "../src/lib/stream-deploy.js";
import { recoverBrokenDeploy, activeDeployIds } from "../src/lib/deploy-recovery.js";

const mRecover = recoverBrokenDeploy as unknown as ReturnType<typeof vi.fn>;

describe("streamDeploy: recoverBrokenDeploy rejection in the catch block", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeDeployIds.clear();
  });

  it("awaits recoverBrokenDeploy before resolving (not fire-and-forget): streamDeploy must not settle while recoverBrokenDeploy's promise is still pending", async () => {
    // A deferred promise, not mockRejectedValue's already-rejected one: this
    // is what actually distinguishes "awaited" from "fire-and-forget" (an
    // already-settled mock's rejection races the assertions regardless of
    // whether the SUT awaits it, but a still-pending one can only have been
    // reached by the SUT if it's genuinely waiting on it).
    let settleRecover!: () => void;
    const controlled = new Promise<void>((_resolve, reject) => {
      settleRecover = () => reject(new Error("recovery boom"));
    });
    // Attach our own observer so a pending rejection here never becomes an
    // unhandled one purely as a test artifact (the SUT's own handling is
    // what this test actually asserts, via the ordering below).
    controlled.catch(() => {});
    mRecover.mockReturnValue(controlled);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connect ECONNREFUSED"));

    let streamSettled = false;
    const streamPromise = streamDeploy({
      serverId: "srv-a",
      deployId: "d1",
      appId: "app-1",
      appName: "thd",
      relayUrl: "http://relay.example",
      relayToken: null,
      body: {},
    }).then(() => {
      streamSettled = true;
    });

    await vi.waitFor(() => expect(mRecover).toHaveBeenCalledOnce());

    // Flush a few microtask turns. Fire-and-forget code (the mutant) falls
    // through the catch block and out of streamDeploy in the SAME tick it
    // calls recoverBrokenDeploy, so streamSettled would already be true
    // here even though `controlled` hasn't been settled yet.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(streamSettled).toBe(false);
    expect(activeDeployIds.has("d1")).toBe(true); // finally hasn't run yet either

    settleRecover();
    await streamPromise;

    expect(streamSettled).toBe(true);
    // Cleared once recovery has settled: otherwise a real deploy that hit
    // this path would be permanently excluded from the stuck-sweep too.
    expect(activeDeployIds.has("d1")).toBe(false);

    fetchSpy.mockRestore();
  });
});
