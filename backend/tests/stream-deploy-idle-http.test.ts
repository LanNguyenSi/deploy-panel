import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real fetch against a real local server: undici errors the body read when the
// fetch signal aborts, even after the relay closed the stream. The idle timer
// must therefore not run while the panel handles a `done` event (the post-deploy
// health check can take far longer than the idle window).

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    app: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
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
  verifyDeployHealth: vi.fn(),
}));

import { prisma } from "../src/lib/prisma.js";
import { recoverBrokenDeploy } from "../src/lib/deploy-recovery.js";
import { verifyDeployHealth } from "../src/lib/post-deploy-gate.js";
import { streamDeploy } from "../src/lib/stream-deploy.js";

const mAppFindUnique = (prisma.app as any).findUnique as ReturnType<typeof vi.fn>;
const mDeployFindUnique = (prisma.deploy as any).findUnique as ReturnType<typeof vi.fn>;
const mDeployUpdate = (prisma.deploy as any).update as ReturnType<typeof vi.fn>;
const mRecover = recoverBrokenDeploy as unknown as ReturnType<typeof vi.fn>;
const mVerify = verifyDeployHealth as unknown as ReturnType<typeof vi.fn>;

const IDLE_MS = 150;
const HEALTH_CHECK_MS = 600; // several idle windows

let server: Server;
let relayUrl: string;
let jsonMode = false;

beforeEach(async () => {
  jsonMode = false;
  vi.clearAllMocks();
  mAppFindUnique.mockResolvedValue({ requiredEnvKeys: [], liveUrl: null });
  let currentStatus = "running";
  mDeployUpdate.mockImplementation(async (args: any) => {
    if (args?.data?.status) currentStatus = args.data.status;
    return {};
  });
  mDeployFindUnique.mockImplementation(async () => ({ status: currentStatus }));
  mVerify.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ healthy: true }), HEALTH_CHECK_MS)));

  server = createServer((_req, res) => {
    if (jsonMode) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: { success: true, durationMs: 5 } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    // A heartbeat first, so the short window applies to the read that returns `done`.
    res.write(": ping\n\n");
    const done = { success: true, steps: [{ name: "compose up", status: "success", durationMs: 1 }], durationMs: 5 };
    res.end(`event: done\ndata: ${JSON.stringify(done)}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  relayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("streamDeploy: finalizing after `done` is not relay silence", () => {
  it("a post-deploy health check longer than the idle window does not trigger recovery", async () => {
    await streamDeploy({
      serverId: "srv-a",
      deployId: "d1",
      appId: "app-1",
      appName: "my-app",
      relayUrl,
      relayToken: null,
      body: {},
      timeouts: { idleMs: IDLE_MS, firstByteMs: IDLE_MS },
    });

    expect(mVerify).toHaveBeenCalledTimes(1);
    expect(mRecover).not.toHaveBeenCalled();
    const statuses = mDeployUpdate.mock.calls.map((c) => c[0].data.status).filter(Boolean);
    expect(statuses).toEqual(["success"]);
  });

  it("a JSON relay answer is finalized without the timer still running", async () => {
    jsonMode = true;
    await streamDeploy({
      serverId: "srv-a",
      deployId: "d1",
      appId: "app-1",
      appName: "my-app",
      relayUrl,
      relayToken: null,
      body: {},
      timeouts: { idleMs: IDLE_MS, firstByteMs: IDLE_MS },
    });

    expect(mVerify).toHaveBeenCalledTimes(1);
    expect(mRecover).not.toHaveBeenCalled();
    expect(mDeployUpdate.mock.calls.map((c) => c[0].data.status).filter(Boolean)).toEqual(["success"]);
  });
});
