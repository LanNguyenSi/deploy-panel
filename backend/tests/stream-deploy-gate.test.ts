import { describe, expect, it, vi, beforeEach } from "vitest";

// Focused on the NEW pre-deploy gate wired into streamDeploy(): provisioning
// panel-managed secrets into the relay's .env before compose runs, and
// hard-blocking the deploy (never reaching the relay's /deploy endpoint) when
// a declared-required env key still resolves empty afterwards. The SSE/JSON
// event-handling behavior of streamDeploy is exercised by
// apps-name-validation.test.ts / v1-api.test.ts at the route level (which
// mock streamDeploy itself) — this file is the one place the real function
// runs, scoped to the gate.

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    app: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    deploy: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../src/lib/provision-secrets.js", () => ({
  provisionAndCheckAppSecrets: vi.fn(),
}));

vi.mock("../src/lib/deploy-recovery.js", () => ({
  recoverBrokenDeploy: vi.fn(),
}));

// finalizeDeploy (invoked once streamDeploy gets past the gate and the relay
// deploy call succeeds) runs the post-deploy health gate — mock it out so
// this file stays hermetic and scoped to the pre-deploy provisioning gate.
vi.mock("../src/lib/post-deploy-gate.js", () => ({
  verifyDeployHealth: vi.fn().mockResolvedValue({ healthy: true }),
}));

import { prisma } from "../src/lib/prisma.js";
import { provisionAndCheckAppSecrets } from "../src/lib/provision-secrets.js";
import { recoverBrokenDeploy } from "../src/lib/deploy-recovery.js";
import { streamDeploy } from "../src/lib/stream-deploy.js";

const mAppFindUnique = (prisma.app as any).findUnique as ReturnType<typeof vi.fn>;
const mAppUpdate = (prisma.app as any).update as ReturnType<typeof vi.fn>;
const mDeployUpdate = (prisma.deploy as any).update as ReturnType<typeof vi.fn>;
const mProvision = provisionAndCheckAppSecrets as unknown as ReturnType<typeof vi.fn>;

const lastCall = (m: ReturnType<typeof vi.fn>) => m.mock.calls[m.mock.calls.length - 1][0];

const baseOpts = {
  serverId: "srv-a",
  deployId: "d1",
  appId: "app-1",
  appName: "thd",
  relayUrl: "http://relay.example",
  relayToken: null,
  body: {},
};

describe("streamDeploy — pre-deploy secret provisioning + required-env gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mAppFindUnique.mockResolvedValue({ requiredEnvKeys: ["METRICS_API_TOKEN"] });
  });

  it("blocks the deploy BEFORE calling the relay when a required key is still missing after provisioning", async () => {
    mProvision.mockResolvedValue({ provisionedKeys: [], wrote: false, missing: ["METRICS_API_TOKEN"] });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await streamDeploy(baseOpts);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lastCall(mDeployUpdate).data.status).toBe("failed");
    expect(lastCall(mAppUpdate).data.status).toBe("unhealthy");
    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps.at(-1)).toMatchObject({ name: "env-preflight", status: "failure" });
    expect(steps.at(-1).output).toContain("METRICS_API_TOKEN");
    expect(recoverBrokenDeploy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("proceeds to call the relay's deploy endpoint once provisioning leaves nothing missing", async () => {
    mProvision.mockResolvedValue({ provisionedKeys: ["METRICS_API_TOKEN"], wrote: true, missing: [] });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      body: {} as any,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ result: { success: true, steps: [] } }),
    } as unknown as Response);

    await streamDeploy(baseOpts);

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://relay.example/api/apps/thd/deploy?stream=true",
      expect.objectContaining({ method: "POST" }),
    );

    fetchSpy.mockRestore();
  });

  it("passes requiredEnvKeys from the app row into provisioning, defaulting to [] when the app has none declared", async () => {
    mAppFindUnique.mockResolvedValue({ requiredEnvKeys: [] });
    mProvision.mockResolvedValue({ provisionedKeys: [], wrote: false, missing: [] });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      body: {} as any,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ result: { success: true, steps: [] } }),
    } as unknown as Response);

    await streamDeploy(baseOpts);

    expect(mProvision).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv-a", appId: "app-1", appName: "thd", requiredKeys: [] }),
    );

    fetchSpy.mockRestore();
  });

  it("records which panel-managed secrets were (re)provisioned by key name only, never a value", async () => {
    mProvision.mockResolvedValue({ provisionedKeys: ["METRICS_API_TOKEN"], wrote: true, missing: [] });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      body: {} as any,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ result: { success: true, steps: [] } }),
    } as unknown as Response);

    await streamDeploy(baseOpts);

    const deployUpdateData = mDeployUpdate.mock.calls[0]?.[0]?.data;
    expect(deployUpdateData?.log).toContain("provision-secrets");
    expect(deployUpdateData?.log).toContain("METRICS_API_TOKEN");

    fetchSpy.mockRestore();
  });
});
