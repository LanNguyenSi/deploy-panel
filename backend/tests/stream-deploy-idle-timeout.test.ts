import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The streaming fetch to the relay has no cap on the total length of a deploy.
// Every wait (response headers, each gap between chunks) tolerates
// STREAM_FIRST_BYTE_TIMEOUT_MS of silence until a `: ping` comment line has
// been seen, so a relay without the heartbeat is no worse off than under the
// old fixed cap, whatever step events it sent before going quiet. Once a ping
// has been seen the window is STREAM_IDLE_TIMEOUT_MS. Any abort falls back to
// recovery.

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
import { STREAM_FIRST_BYTE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, streamDeploy } from "../src/lib/stream-deploy.js";

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

describe("streamDeploy: idle timeout instead of a fixed total cap", () => {
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

  it("heartbeats keep a stream open far past the old 10 minute cap, then it completes", async () => {
    let stream!: ReturnType<typeof liveStream>;
    // Fake timers do not drive AbortSignal.timeout, so a fixed total cap would
    // go unnoticed here unless the call itself is pinned.
    const totalCap = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      stream = liveStream(init!.signal as AbortSignal);
      return stream.res;
    });

    const run = streamDeploy(opts);
    await vi.advanceTimersByTimeAsync(0);
    stream.send(`event: step\ndata: ${JSON.stringify({ name: "compose up", status: "success", durationMs: 1 })}\n\n`);

    // 60 heartbeats = 15 minutes, 1.5x the old fixed cap.
    for (let i = 0; i < 60; i++) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      stream.send(": ping\n\n");
    }
    expect(mRecover).not.toHaveBeenCalled();

    stream.send(`event: step\ndata: ${JSON.stringify({ name: "health check", status: "success", durationMs: 1 })}\n\n`);
    stream.close();
    await run;

    expect(mRecover).not.toHaveBeenCalled();
    expect(totalCap).not.toHaveBeenCalled();
    const last = mDeployUpdate.mock.calls[mDeployUpdate.mock.calls.length - 1][0];
    expect(last.data.status).toBe("success");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a stream that goes silent past the idle timeout is aborted and falls back to recovery", async () => {
    let stream!: ReturnType<typeof liveStream>;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      stream = liveStream(init!.signal as AbortSignal);
      return stream.res;
    });

    const run = streamDeploy(opts);
    await vi.advanceTimersByTimeAsync(0);
    stream.send(": ping\n\n");
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1);
    expect(mRecover).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await run;

    expect(mRecover).toHaveBeenCalledTimes(1);
    expect(mRecover.mock.calls[0][0]).toBe("d1");
    expect(String(mRecover.mock.calls[0][4])).toContain("no data from the relay");
    expect(vi.getTimerCount()).toBe(0);
  });

  const stepEvent = (name: string) => `event: step\ndata: ${JSON.stringify({ name, status: "success", durationMs: 1 })}\n\n`;

  it("a relay that never sends response headers aborts at the first-byte window, not before", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init!.signal as AbortSignal;
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );

    const run = streamDeploy(opts);
    await vi.advanceTimersByTimeAsync(STREAM_FIRST_BYTE_TIMEOUT_MS - 1);
    expect(mRecover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await run;

    expect(mRecover).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a relay without heartbeat that is silent for 5 minutes after the headers keeps the stream", async () => {
    let stream!: ReturnType<typeof liveStream>;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      stream = liveStream(init!.signal as AbortSignal);
      return stream.res;
    });

    const run = streamDeploy(opts);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(mRecover).not.toHaveBeenCalled();
    stream.send(stepEvent("compose up"));
    stream.close();
    await run;

    expect(mRecover).not.toHaveBeenCalled();
    expect(mDeployUpdate.mock.calls[mDeployUpdate.mock.calls.length - 1][0].data.status).toBe("success");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("silence before any chunk aborts at the first-byte window", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => liveStream(init!.signal as AbortSignal).res);

    const run = streamDeploy(opts);
    await vi.advanceTimersByTimeAsync(STREAM_FIRST_BYTE_TIMEOUT_MS - 1);
    expect(mRecover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(mRecover).toHaveBeenCalledTimes(1);
  });

  it("late headers restart the first-byte window, and the first ping switches to the short window", async () => {
    let stream!: ReturnType<typeof liveStream>;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const signal = init!.signal as AbortSignal;
      await new Promise((resolve) => setTimeout(resolve, STREAM_FIRST_BYTE_TIMEOUT_MS - 1));
      stream = liveStream(signal);
      return stream.res;
    });

    const run = streamDeploy(opts);
    await vi.advanceTimersByTimeAsync(STREAM_FIRST_BYTE_TIMEOUT_MS - 1);
    // Headers are in. The first-byte window starts over: 599 s more is fine.
    await vi.advanceTimersByTimeAsync(STREAM_FIRST_BYTE_TIMEOUT_MS - 1);
    expect(mRecover).not.toHaveBeenCalled();

    stream.send(": ping\n\n");
    // After the first chunk the short window rules: just inside it is fine ...
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1);
    expect(mRecover).not.toHaveBeenCalled();
    // ... and it aborts exactly at the idle limit.
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(mRecover).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a step event followed by 190 s of silence keeps the stream (no heartbeat seen)", async () => {
    let stream!: ReturnType<typeof liveStream>;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      stream = liveStream(init!.signal as AbortSignal);
      return stream.res;
    });

    const run = streamDeploy(opts);
    await vi.advanceTimersByTimeAsync(2_000);
    stream.send(stepEvent("git pull"));
    await vi.advanceTimersByTimeAsync(190_000);
    expect(mRecover).not.toHaveBeenCalled();
    stream.send(stepEvent("compose up"));
    stream.close();
    await run;

    expect(mRecover).not.toHaveBeenCalled();
    expect(mDeployUpdate.mock.calls[mDeployUpdate.mock.calls.length - 1][0].data.status).toBe("success");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("step events without pings: a gap just under the first-byte window is fine, the window itself aborts", async () => {
    let stream!: ReturnType<typeof liveStream>;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      stream = liveStream(init!.signal as AbortSignal);
      return stream.res;
    });

    const run = streamDeploy(opts);
    await vi.advanceTimersByTimeAsync(0);
    stream.send(stepEvent("git pull"));
    await vi.advanceTimersByTimeAsync(STREAM_FIRST_BYTE_TIMEOUT_MS - 1);
    expect(mRecover).not.toHaveBeenCalled();
    stream.send(stepEvent("compose build"));
    await vi.advanceTimersByTimeAsync(STREAM_FIRST_BYTE_TIMEOUT_MS - 1);
    expect(mRecover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(mRecover).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a ping after step events switches to the short window", async () => {
    let stream!: ReturnType<typeof liveStream>;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      stream = liveStream(init!.signal as AbortSignal);
      return stream.res;
    });

    const run = streamDeploy(opts);
    await vi.advanceTimersByTimeAsync(0);
    stream.send(stepEvent("git pull"));
    await vi.advanceTimersByTimeAsync(1_000);
    stream.send(": ping\n\n");
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1);
    expect(mRecover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(mRecover).toHaveBeenCalledTimes(1);
  });

  it("late headers restart the window for a JSON body that is read inside the fresh window", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const signal = init!.signal as AbortSignal;
      await new Promise((resolve) => setTimeout(resolve, STREAM_FIRST_BYTE_TIMEOUT_MS - 1));
      return {
        ok: true,
        status: 200,
        body: {},
        headers: new Headers({ "content-type": "application/json" }),
        json: () =>
          new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason));
            setTimeout(() => resolve({ result: { success: true, durationMs: 5 } }), STREAM_FIRST_BYTE_TIMEOUT_MS - 1);
          }),
      } as unknown as Response;
    });

    const run = streamDeploy(opts);
    await vi.advanceTimersByTimeAsync(2 * STREAM_FIRST_BYTE_TIMEOUT_MS);
    await run;

    expect(mRecover).not.toHaveBeenCalled();
    expect(mDeployUpdate.mock.calls[mDeployUpdate.mock.calls.length - 1][0].data.status).toBe("success");
    expect(vi.getTimerCount()).toBe(0);
  });
});
