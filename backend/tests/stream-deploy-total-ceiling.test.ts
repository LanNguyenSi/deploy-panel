import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The silence windows bound quiet stretches only. A relay that keeps the
// stream technically alive forever (a `: ping` every 15 s, or step events
// just inside the windows) but never finishes must end at the total ceiling
// (STREAM_TOTAL_CEILING_MS, wall-clock from the start of the dispatch, not
// disarmed while events are handled). Its abort carries its own reason and
// falls back to the same connection-lost recovery as a silence timeout. A
// deploy that finishes inside the ceiling is unaffected and leaves no timer
// behind.

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

import { prisma } from "../src/lib/prisma.js";
import { recoverBrokenDeploy } from "../src/lib/deploy-recovery.js";
import { STREAM_TOTAL_CEILING_MS, streamDeploy } from "../src/lib/stream-deploy.js";

const mAppFindUnique = (prisma.app as any).findUnique as ReturnType<typeof vi.fn>;
const mDeployFindUnique = (prisma.deploy as any).findUnique as ReturnType<typeof vi.fn>;
const mDeployUpdate = (prisma.deploy as any).update as ReturnType<typeof vi.fn>;
const mRecover = recoverBrokenDeploy as unknown as ReturnType<typeof vi.fn>;

const opts = {
  serverId: "srv-a",
  deployId: "d1",
  appId: "app-1",
  appName: "my-app",
  relayUrl: "http://relay.example",
  relayToken: null,
  body: {},
};

const HEARTBEAT_MS = 15_000;
const CEILING_MS = 60_000;
const enc = new TextEncoder();

/** A live SSE response whose body errors when the fetch signal aborts, like a real one. */
function liveStream(signal: AbortSignal) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      signal.addEventListener("abort", () => c.error(signal.reason));
    },
  });
  const res = { ok: true, status: 200, body, headers: new Headers({ "content-type": "text/event-stream" }) } as unknown as Response;
  return { res, send: (text: string) => controller.enqueue(enc.encode(text)), close: () => controller.close() };
}

const stepEvent = (name: string) => `event: step\ndata: ${JSON.stringify({ name, status: "success", durationMs: 1 })}\n\n`;

describe("streamDeploy: total ceiling on a stream that never finishes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mAppFindUnique.mockResolvedValue({ requiredEnvKeys: [] });
    let currentStatus = "running";
    mDeployUpdate.mockImplementation(async (args: any) => {
      if (args?.data?.status) currentStatus = args.data.status;
      return {};
    });
    mDeployFindUnique.mockImplementation(async () => ({ status: currentStatus }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("exports a total ceiling of 4 hours", () => {
    expect(STREAM_TOTAL_CEILING_MS).toBe(4 * 60 * 60 * 1000);
  });

  it("a stream that heartbeats forever ends at the ceiling with the ceiling reason, through recovery", async () => {
    let stream!: ReturnType<typeof liveStream>;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      stream = liveStream(init!.signal as AbortSignal);
      return stream.res;
    });

    const run = streamDeploy({ ...opts, timeouts: { totalCeilingMs: CEILING_MS } });
    await vi.advanceTimersByTimeAsync(0);

    // Three heartbeats, one per 15 s: the silence windows never trigger, and
    // 45 s is still well under the 60 s ceiling.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      stream.send(": ping\n\n");
    }
    expect(mRecover).not.toHaveBeenCalled();

    // The ceiling is wall-clock from the dispatch: it fires exactly at 60 s
    // even though the stream never went quiet.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    await run;

    expect(mRecover).toHaveBeenCalledTimes(1);
    expect(mRecover.mock.calls[0][0]).toBe("d1");
    const reason = String(mRecover.mock.calls[0][4]);
    expect(reason).toContain("total ceiling");
    expect(reason).not.toContain("no data from the relay");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a deploy that finishes inside the ceiling is unaffected and leaves no timer behind", async () => {
    let stream!: ReturnType<typeof liveStream>;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      stream = liveStream(init!.signal as AbortSignal);
      return stream.res;
    });

    const run = streamDeploy({ ...opts, timeouts: { totalCeilingMs: CEILING_MS } });
    await vi.advanceTimersByTimeAsync(0);
    stream.send(": ping\n\n");
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    stream.send(stepEvent("compose up"));
    stream.close();
    await run;

    expect(mRecover).not.toHaveBeenCalled();
    expect(mDeployUpdate.mock.calls[mDeployUpdate.mock.calls.length - 1][0].data.status).toBe("success");
    expect(vi.getTimerCount()).toBe(0);
  });
});
