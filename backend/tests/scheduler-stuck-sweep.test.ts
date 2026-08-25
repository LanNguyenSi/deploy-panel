import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// AC1 (task f760b81d): the stuck-deploy sweep must now run periodically
// (via startScheduler), not just once at process boot, and must never touch
// a deploy this process still has active regardless of age. This exercises
// the REAL recoverStuckDeploys() (imported by scheduler.ts's startScheduler)
// through fake timers, so it proves the wiring, not just that the function
// works in isolation (that's startup-recovery.test.ts's job).

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    scheduledDeploy: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
    app: {
      upsert: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn(),
    },
    deploy: {
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("../src/lib/stream-deploy.js", () => ({ streamDeploy: vi.fn() }));

import { prisma } from "../src/lib/prisma.js";
import { startScheduler } from "../src/lib/scheduler.js";
import { activeDeployIds } from "../src/lib/deploy-recovery.js";

const mDeployFindMany = (prisma.deploy as any).findMany as ReturnType<typeof vi.fn>;
const mDeployUpdate = (prisma.deploy as any).update as ReturnType<typeof vi.fn>;

const oldCreatedAt = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago, well past the 2-min threshold

const makeStuckDeploy = (id: string) => ({
  id,
  createdAt: oldCreatedAt,
  log: null,
  appId: `app-${id}`,
  app: { name: `app-${id}` },
  server: { id: "srv-a", relayUrl: null, relayToken: null },
});

describe("startScheduler — periodic stuck-deploy sweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeDeployIds.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    activeDeployIds.clear();
  });

  it("finalizes an orphaned running deploy after one sweep interval, and its query excludes a deploy id this process still has active", async () => {
    mDeployFindMany.mockImplementation(async (args: any) => {
      // Simulates what a real `id: { notIn }` filter returns: exclude ids
      // in the set the query was built with.
      const excluded: string[] = args.where.id.notIn;
      return [makeStuckDeploy("orphan-1")].filter((d) => !excluded.includes(d.id));
    });

    activeDeployIds.add("active-1");

    startScheduler();
    // Nothing should have run synchronously.
    expect(mDeployFindMany).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(mDeployFindMany).toHaveBeenCalled();
    const queryArgs = mDeployFindMany.mock.calls[0][0];
    expect(queryArgs.where.id.notIn).toContain("active-1");

    const updatedIds = mDeployUpdate.mock.calls.map((c) => c[0].where.id);
    expect(updatedIds).toContain("orphan-1");
    expect(updatedIds).not.toContain("active-1");
  });

  it("sweeps again on the next interval (proves it's periodic, not a one-shot)", async () => {
    mDeployFindMany.mockResolvedValue([]);

    startScheduler();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mDeployFindMany).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mDeployFindMany).toHaveBeenCalledTimes(2);
  });
});
