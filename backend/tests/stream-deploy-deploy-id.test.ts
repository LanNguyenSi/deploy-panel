import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    app: { findUnique: vi.fn().mockResolvedValue({ requiredEnvKeys: [] }), update: vi.fn().mockResolvedValue({}) },
    deploy: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../src/lib/provision-secrets.js", () => ({
  provisionAndCheckAppSecrets: vi.fn().mockResolvedValue({ provisionedKeys: [], wrote: false, missing: [] }),
}));

vi.mock("../src/lib/deploy-recovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/deploy-recovery.js")>();
  return { ...actual, recoverBrokenDeploy: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../src/lib/post-deploy-gate.js", () => ({
  verifyDeployHealth: vi.fn().mockResolvedValue({ healthy: true }),
}));

import { prisma } from "../src/lib/prisma.js";
import { recoverBrokenDeploy } from "../src/lib/deploy-recovery.js";
import { streamDeploy } from "../src/lib/stream-deploy.js";

const mDeployUpdate = (prisma.deploy as any).update as ReturnType<typeof vi.fn>;
const mAppUpdate = (prisma.app as any).update as ReturnType<typeof vi.fn>;

const opts = {
  serverId: "srv-a",
  deployId: "9f1c2d3e-0000-4000-8000-000000000001",
  appId: "app-1",
  appName: "my-app",
  relayUrl: "http://relay.example",
  relayToken: "tok",
  body: {},
};

describe("streamDeploy sends the panel deploy id to the relay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the Deploy row id as X-Deploy-Id on the relay deploy call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => "x",
    } as unknown as Response);

    await streamDeploy(opts);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Deploy-Id"]).toBe(opts.deployId);
    expect(headers["Authorization"]).toBe("Bearer tok");
    fetchSpy.mockRestore();
  });

  it("a relay 400 for the id is a deploy-start failure, not a lost connection", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => '{"error":"Invalid X-Deploy-Id header: deployId must be 1-128 characters from [A-Za-z0-9._:-]"}',
    } as unknown as Response);

    await streamDeploy(opts);

    expect(recoverBrokenDeploy).not.toHaveBeenCalled();
    const update = mDeployUpdate.mock.calls[mDeployUpdate.mock.calls.length - 1][0];
    expect(update.data.status).toBe("failed");
    expect(update.data.log).toContain("Relay rejected the deploy: 400");
    expect(update.data.log).toContain("X-Deploy-Id");
    expect(mAppUpdate.mock.calls[mAppUpdate.mock.calls.length - 1][0].data.status).toBe("unhealthy");
    fetchSpy.mockRestore();
  });
});
