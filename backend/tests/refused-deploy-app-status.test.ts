import { describe, expect, it, vi, beforeEach } from "vitest";

// A deploy whose app name the relay path builder refuses (RELAY_APP_NAME_
// PATTERN, lib/relay-path.ts) is finalized like the panel's own preflight
// refusal: the App row goes back to the status it had before the dispatch
// wrote `deploying`. Without that restore the card would sit on `deploying`
// until the stuck-sweep's reconcileDeployingApps settled it from the deploy
// history. The prisma fake below keeps one App status in memory, so the test
// follows the whole path: dispatch (status `deploying`), refused deploy, then
// a sweep pass.

const db = vi.hoisted(() => ({
  status: "deploying",
  /** What statusAfterBlocked's history lookup (a deploy.findMany scoped to the app) returns. */
  history: [] as Array<{ status: string; log: string | null }>,
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    app: {
      findUnique: vi.fn().mockResolvedValue({ requiredEnvKeys: [] }),
      update: vi.fn(async ({ data }: { data: { status?: string } }) => {
        if (data.status) db.status = data.status;
        return {};
      }),
      // reconcileDeployingApps asks for apps on `deploying`; the startup name
      // audit asks for every row with no where clause.
      findMany: vi.fn(async (args: { where?: { status?: string } }) =>
        args.where?.status === "deploying" && db.status === "deploying" ? [{ id: "app-1", name: "my.app", deploys: [] }] : [],
      ),
      updateMany: vi.fn(async ({ where, data }: { where: { status?: string }; data: { status: string } }) => {
        if (where.status !== db.status) return { count: 0 };
        db.status = data.status;
        return { count: 1 };
      }),
    },
    deploy: {
      findUnique: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn(async (args: { where?: { appId?: string } }) => (args.where?.appId ? db.history : [])),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

vi.mock("../src/lib/provision-secrets.js", () => ({
  provisionAndCheckAppSecrets: vi.fn().mockResolvedValue({ provisionedKeys: [], wrote: false, missing: [] }),
}));

vi.mock("../src/lib/relay.js", () => ({ relayRequest: vi.fn() }));

vi.mock("../src/lib/post-deploy-gate.js", () => ({
  verifyDeployHealth: vi.fn().mockResolvedValue({ healthy: true }),
}));

import { prisma } from "../src/lib/prisma.js";
import { streamDeploy } from "../src/lib/stream-deploy.js";
import { recoverStuckDeploys } from "../src/lib/startup.js";

const mAppUpdateMany = prisma.app.updateMany as unknown as ReturnType<typeof vi.fn>;
const mDeployUpdate = prisma.deploy.update as unknown as ReturnType<typeof vi.fn>;

async function refusedDeploy(previousStatus: string | undefined) {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  await streamDeploy({
    serverId: "srv-a",
    deployId: "9f1c2d3e-0000-4000-8000-000000000003",
    appId: "app-1",
    appName: "my.app",
    relayUrl: "http://relay.example",
    relayToken: "tok",
    body: {},
    previousStatus,
  });
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
}

describe("a deploy refused for its app name restores the App status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.status = "deploying"; // what the dispatch wrote before streamDeploy ran
    db.history = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it.each(["healthy", "unhealthy", "unknown"])(
    "after a refused deploy the App status equals the status before the dispatch (%s) and the sweep leaves it alone",
    async (previous) => {
      await refusedDeploy(previous);

      expect(db.status).toBe(previous);
      const row = JSON.parse(mDeployUpdate.mock.calls[0][0].data.log);
      expect(row[0].kind).toBe("preflight-check");

      await recoverStuckDeploys();

      expect(db.status).toBe(previous);
      expect(mAppUpdateMany).not.toHaveBeenCalled();
    },
  );

  it("without a captured previous status it falls back to the last real deploy's outcome (failed -> unhealthy)", async () => {
    db.history = [{ status: "failed", log: JSON.stringify([{ name: "deploy", status: "failure" }]) }];
    await refusedDeploy(undefined);
    expect(db.status).toBe("unhealthy");

    await recoverStuckDeploys();
    expect(db.status).toBe("unhealthy");
    expect(mAppUpdateMany).not.toHaveBeenCalled();
  });

  it("with a previous status of deploying (another deploy owns the card) the App row is not written", async () => {
    await refusedDeploy("deploying");
    expect(prisma.app.update).not.toHaveBeenCalled();
    expect(db.status).toBe("deploying");
    // The row itself is still finalized failed.
    expect(mDeployUpdate.mock.calls[0][0].data.status).toBe("failed");
  });
});
