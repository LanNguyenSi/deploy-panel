import { describe, expect, it, vi, beforeEach } from "vitest";

// End-to-end proof (HIGH-2 fix) that a scheduled deploy is subject to the
// SAME pre-deploy provisioning + required-env hard-fail gate as every other
// deploy trigger. Unlike scheduler.test.ts (which mocks stream-deploy.js to
// test checkScheduled()'s own delegation), this file uses the REAL
// streamDeploy() so a future edit that reintroduces a second, ungated
// relay-call path in checkScheduled() would fail here even if it still
// "calls streamDeploy" on paper.
//
// Everything below streamDeploy that isn't the gate itself (provisioning,
// the post-deploy health check) is mocked so this file stays focused and
// hermetic, matching stream-deploy-gate.test.ts's own scope.

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    scheduledDeploy: { findMany: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    app: {
      upsert: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn(),
    },
    deploy: { create: vi.fn(), update: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../src/lib/provision-secrets.js", () => ({
  provisionAndCheckAppSecrets: vi.fn(),
}));

vi.mock("../src/lib/post-deploy-gate.js", () => ({
  verifyDeployHealth: vi.fn().mockResolvedValue({ healthy: true }),
}));

vi.mock("../src/lib/deploy-recovery.js", () => ({
  recoverBrokenDeploy: vi.fn(),
}));

import { prisma } from "../src/lib/prisma.js";
import { provisionAndCheckAppSecrets } from "../src/lib/provision-secrets.js";
import { checkScheduled } from "../src/lib/scheduler.js";

const mScheduledDeploy = prisma.scheduledDeploy as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mApp = prisma.app as unknown as {
  upsert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
};
const mDeploy = prisma.deploy as unknown as {
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mProvision = provisionAndCheckAppSecrets as unknown as ReturnType<typeof vi.fn>;

const dueEntry = {
  id: "sched-1",
  serverId: "srv-a",
  appName: "thd",
  scheduledFor: new Date(Date.now() - 1000),
  force: false,
  status: "pending",
  deployId: null,
  createdAt: new Date(),
  server: { id: "srv-a", name: "my-server", relayUrl: "http://relay.example", relayToken: "relay-tok" },
};

describe("checkScheduled — required-env gate enforced end-to-end (real streamDeploy)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mScheduledDeploy.findMany.mockResolvedValue([dueEntry]);
    mApp.upsert.mockResolvedValue({ id: "app-1", name: "thd" });
    mApp.findUnique.mockResolvedValue({ requiredEnvKeys: ["METRICS_API_TOKEN"] });
    mDeploy.create.mockResolvedValue({ id: "deploy-1" });
  });

  it("does NOT hit the relay deploy endpoint when a required env key is missing after provisioning", async () => {
    mProvision.mockResolvedValue({ provisionedKeys: [], wrote: false, missing: ["METRICS_API_TOKEN"] });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await checkScheduled();
    await new Promise((r) => setTimeout(r, 0)); // flush streamDeploy's fire-and-forget

    expect(fetchSpy).not.toHaveBeenCalled();
    const failedUpdate = mDeploy.update.mock.calls.find((c) => c[0].data?.status === "failed");
    expect(failedUpdate).toBeTruthy();
    expect(failedUpdate![0].data.log).toContain("METRICS_API_TOKEN");
    expect(mApp.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "app-1" }, data: expect.objectContaining({ status: "unhealthy" }) }),
    );

    fetchSpy.mockRestore();
  });

  it("provisions then deploys (reaches the relay) once the required key is satisfied", async () => {
    mProvision.mockResolvedValue({ provisionedKeys: ["METRICS_API_TOKEN"], wrote: true, missing: [] });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      body: {} as any,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ result: { success: true, steps: [] } }),
    } as unknown as Response);

    await checkScheduled();
    await new Promise((r) => setTimeout(r, 0));

    expect(mProvision).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv-a", appId: "app-1", appName: "thd", requiredKeys: ["METRICS_API_TOKEN"] }),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://relay.example/api/apps/thd/deploy?stream=true",
      expect.objectContaining({ method: "POST" }),
    );

    fetchSpy.mockRestore();
  });
});
