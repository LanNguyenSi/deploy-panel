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

// appName is interpolated into the relay deploy URL. `POST /api/scheduled`
// and the v1 routes now validate names, but a ScheduledDeploy row stored
// before that guard can carry anything, so streamDeploy must encode the
// name itself rather than let it rewrite the URL path.
async function firstFetchUrl(appName: string): Promise<string> {
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

  const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
  fetchSpy.mockRestore();
  return url;
}

describe("streamDeploy percent-encodes the app name in the relay deploy URL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a plain name passes through unchanged", async () => {
    expect(await firstFetchUrl("my-app")).toBe("http://relay.example/api/apps/my-app/deploy?stream=true");
  });

  it("a name containing a space is percent-encoded", async () => {
    expect(await firstFetchUrl("my app")).toBe("http://relay.example/api/apps/my%20app/deploy?stream=true");
  });

  it("a name with a path separator or a quote cannot escape the path segment", async () => {
    expect(await firstFetchUrl('a/b"c')).toBe("http://relay.example/api/apps/a%2Fb%22c/deploy?stream=true");
  });
});
