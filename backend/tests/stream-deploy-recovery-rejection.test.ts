import { describe, expect, it, vi, beforeEach } from "vitest";

// AC2 (task f760b81d): streamDeploy's catch used to call recoverBrokenDeploy
// fire-and-forget (no await, no .catch). If recoverBrokenDeploy itself
// rejected (before any of its own internal prisma calls, which each already
// have a trailing .catch), that became an unhandled rejection AND left the
// deploy record on "running" forever, since nothing ever finalized it. Now
// the call is awaited with its own .catch, so a rejection there is logged
// and swallowed instead of propagating, and the deploy id is still removed
// from activeDeployIds (see the `finally` in stream-deploy.ts) so the
// periodic stuck-sweep (scheduler-stuck-sweep.test.ts) can still reclaim
// the now-orphaned record later.

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

describe("streamDeploy — recoverBrokenDeploy rejection in the catch block", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mRecover.mockRejectedValue(new Error("recovery boom"));
    activeDeployIds.clear();
  });

  it("does not throw / produce an unhandled rejection when recoverBrokenDeploy itself rejects, and clears the deploy from the active set so the periodic sweep can reclaim it", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(
      streamDeploy({
        serverId: "srv-a",
        deployId: "d1",
        appId: "app-1",
        appName: "thd",
        relayUrl: "http://relay.example",
        relayToken: null,
        body: {},
      }),
    ).resolves.toBeUndefined();

    expect(mRecover).toHaveBeenCalledOnce();
    // Cleared regardless of the rejection — otherwise a real deploy that hit
    // this path would be permanently excluded from the stuck-sweep too.
    expect(activeDeployIds.has("d1")).toBe(false);

    fetchSpy.mockRestore();
  });
});
