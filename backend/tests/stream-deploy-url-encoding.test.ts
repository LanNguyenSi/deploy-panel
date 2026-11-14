import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    app: { findUnique: vi.fn().mockResolvedValue({ requiredEnvKeys: [] }), update: vi.fn().mockResolvedValue({}) },
    deploy: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) },
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
import { streamDeploy } from "../src/lib/stream-deploy.js";
import { recoverBrokenDeploy } from "../src/lib/deploy-recovery.js";
import { provisionAndCheckAppSecrets } from "../src/lib/provision-secrets.js";
import { InvalidAppNameError } from "../src/lib/relay-path.js";

const mRecover = recoverBrokenDeploy as unknown as ReturnType<typeof vi.fn>;
const mProvision = provisionAndCheckAppSecrets as unknown as ReturnType<typeof vi.fn>;
const mDeployUpdate = prisma.deploy.update as unknown as ReturnType<typeof vi.fn>;
const mAppUpdate = prisma.app.update as unknown as ReturnType<typeof vi.fn>;

// streamDeploy builds its relay deploy URL through relayAppPath (lib/relay-
// path.ts), which refuses a name the relay itself refuses (RELAY_APP_NAME_
// PATTERN). A relay-accepted name reaches the relay (encoding it, a no-op for
// that charset). A refused name never reaches the fetch AND is not a lost
// connection: streamDeploy finalizes the row `failed` with a preflight-kind
// step naming the refusal, restores the App row to its pre-dispatch status
// (the same finalization as the panel's own preflight refusal), and must NOT
// hand it to recoverBrokenDeploy (the sweep refuses the same name at its
// preflight, and the health gate would decide this row on an app nothing was
// observed of). The App-status contract against the stuck-sweep is pinned in
// refused-deploy-app-status.test.ts.

async function runDeploy(appName: string): Promise<{ urls: string[] }> {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: false,
    status: 400,
    statusText: "Bad Request",
    text: async () => "x",
  } as unknown as Response);

  await streamDeploy({
    serverId: "srv-a",
    deployId: "9f1c2d3e-0000-4000-8000-000000000001",
    appId: "app-1",
    appName,
    relayUrl: "http://relay.example",
    relayToken: "tok",
    body: {},
    previousStatus: "healthy",
  });

  const urls = fetchSpy.mock.calls.map((c) => c[0] as string);
  fetchSpy.mockRestore();
  return { urls };
}

function refusedFinalize() {
  expect(mDeployUpdate).toHaveBeenCalledTimes(1);
  const data = mDeployUpdate.mock.calls[0][0].data;
  expect(data.status).toBe("failed");
  const steps = JSON.parse(data.log);
  expect(steps).toHaveLength(1);
  expect(steps[0].status).toBe("failure");
  expect(steps[0].kind).toBe("preflight-check");
  expect(steps[0].output).toContain("refusing to build a relay app path");
  // The App card goes back to the status it had before the dispatch.
  expect(mAppUpdate).toHaveBeenCalledTimes(1);
  expect(mAppUpdate.mock.calls[0][0]).toEqual({ where: { id: "app-1" }, data: { status: "healthy" } });
}

describe("streamDeploy builds the relay deploy URL through relayAppPath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mProvision.mockResolvedValue({ provisionedKeys: [], wrote: false, missing: [] });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it.each(["my-app", "_bad", "-bad", "a_b", "9lives"])("calls the relay for the relay-accepted name %j", async (name) => {
    const { urls } = await runDeploy(name);
    expect(urls).toEqual([`http://relay.example/api/apps/${name}/deploy?stream=true`]);
    expect(mRecover).not.toHaveBeenCalled();
  });

  it.each(["..", ".", "a/b", "my app", 'a/b"c', "../x", "my.app", "app.env"])(
    "refuses the name %j before the fetch, finalizes failed naming the refusal, recovers nothing and restores the App status",
    async (name) => {
      const { urls } = await runDeploy(name);
      expect(urls).toEqual([]);
      expect(mRecover).not.toHaveBeenCalled();
      refusedFinalize();
      expect(JSON.parse(mDeployUpdate.mock.calls[0][0].data.log)[0].output).toContain(JSON.stringify(name));
    },
  );

  it("refuses a name the provisioning env read rejected with the same finalization (no recovery, App status restored)", async () => {
    mProvision.mockRejectedValueOnce(new InvalidAppNameError("a.b"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => "x",
    } as unknown as Response);

    await streamDeploy({
      serverId: "srv-a",
      deployId: "9f1c2d3e-0000-4000-8000-000000000002",
      appId: "app-1",
      appName: "a.b",
      relayUrl: "http://relay.example",
      relayToken: "tok",
      body: {},
      previousStatus: "healthy",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(mRecover).not.toHaveBeenCalled();
    refusedFinalize();
  });
});
