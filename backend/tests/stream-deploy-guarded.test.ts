// streamDeploy with connectGuard against a real local SSE listener. The
// classifier is replaced by "everything is public" and a stub resolver maps a
// name to 127.0.0.1, so the guarded transport runs end to end: the stream is
// read, a `done` event finalizes the deploy, and a connection that drops
// mid-stream takes the connection-lost path. Refusals with the real
// classifier are covered in connect-guard.test.ts.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/probe-guard.js", () => ({
  isPrivateOrLoopbackHost: () => false,
  isTrustedRelayServer: () => false,
}));

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
  verifyDeployHealth: vi.fn().mockResolvedValue({ healthy: true }),
}));

import { _setConnectResolver } from "../src/lib/connect-guard.js";
import { prisma } from "../src/lib/prisma.js";
import { recoverBrokenDeploy } from "../src/lib/deploy-recovery.js";
import { streamDeploy } from "../src/lib/stream-deploy.js";

const mDeployUpdate = (prisma.deploy as any).update as ReturnType<typeof vi.fn>;
const mAppFindUnique = (prisma.app as any).findUnique as ReturnType<typeof vi.fn>;
const mRecover = recoverBrokenDeploy as unknown as ReturnType<typeof vi.fn>;

let server: Server;
let port: number;
let mode: "done" | "drop";
let resolverCalls: string[];
let seenHeaders: Record<string, unknown> | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  mAppFindUnique.mockResolvedValue({ requiredEnvKeys: [], liveUrl: null });
  mode = "done";
  resolverCalls = [];
  seenHeaders = undefined;
  _setConnectResolver((host, cb) => {
    resolverCalls.push(host);
    cb(null, [{ address: "127.0.0.1", family: 4 }]);
  });
  server = createServer((req, res) => {
    seenHeaders = req.headers;
    req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(": ping\n\n");
    if (mode === "drop") {
      res.write(`event: step\ndata: ${JSON.stringify({ name: "git pull", status: "success", durationMs: 1 })}\n\n`);
      setTimeout(() => res.socket?.destroy(), 20);
      return;
    }
    const done = { success: true, steps: [{ name: "compose up", status: "success", durationMs: 1 }], durationMs: 5 };
    res.end(`event: done\ndata: ${JSON.stringify(done)}\n\n`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  _setConnectResolver(null);
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const run = () =>
  streamDeploy({
    serverId: "srv-owned",
    deployId: "d1",
    appId: "app-1",
    appName: "thd",
    relayUrl: `http://relay.test:${port}`,
    relayToken: "tok",
    body: {},
    connectGuard: true,
  });

describe("streamDeploy over the guarded transport", () => {
  it("reads the stream and finalizes the deploy on a done event, resolving the name once", async () => {
    await run();
    expect(resolverCalls).toEqual(["relay.test"]);
    expect(seenHeaders?.authorization).toBe("Bearer tok");
    expect(seenHeaders?.["x-deploy-id"]).toBe("d1");
    expect(mDeployUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "success" }) }),
    );
    expect(mRecover).not.toHaveBeenCalled();
  });

  it("a connection that drops mid-stream goes to connection-lost recovery", async () => {
    mode = "drop";
    await run();
    expect(mRecover).toHaveBeenCalledTimes(1);
    expect(mDeployUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "success" }) }),
    );
  });
});
