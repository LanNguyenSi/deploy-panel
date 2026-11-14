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

import { streamDeploy } from "../src/lib/stream-deploy.js";
import { recoverBrokenDeploy } from "../src/lib/deploy-recovery.js";

const mRecover = recoverBrokenDeploy as unknown as ReturnType<typeof vi.fn>;

// streamDeploy builds its relay deploy URL through relayAppPath (lib/relay-
// path.ts), which validates the app name against the shared guard before
// encoding it. A valid name reaches the relay (encoded, a no-op for the guard's
// charset). An invalid name is refused BEFORE the fetch: streamDeploy lands in
// its own catch and hands the row to recoverBrokenDeploy, exactly as it does
// for a dropped connection, so a traversal-shaped name can never escape the
// path segment and the deploy never crashes.

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
  });

  const urls = fetchSpy.mock.calls.map((c) => c[0] as string);
  fetchSpy.mockRestore();
  return { urls };
}

describe("streamDeploy builds the relay deploy URL through relayAppPath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it.each(["my-app", "my.app", "a_b", "9lives"])("calls the relay for the valid name %j", async (name) => {
    const { urls } = await runDeploy(name);
    expect(urls).toEqual([`http://relay.example/api/apps/${name}/deploy?stream=true`]);
    expect(mRecover).not.toHaveBeenCalled();
  });

  it.each(["..", ".", "a/b", "my app", 'a/b"c', "../x"])("refuses the invalid name %j before the fetch", async (name) => {
    const { urls } = await runDeploy(name);
    expect(urls).toEqual([]);
    expect(mRecover).toHaveBeenCalledTimes(1);
  });
});
