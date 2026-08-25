import { describe, expect, it, vi, beforeEach } from "vitest";

// Task 1f6895f6 / the 2026-08-18 project-forge incident (deploy 8ab63a36):
// a health-check failure triggered the relay's auto-rollback, but the
// deploy record never learned about it — no rollback step in the log, no
// commitBefore/After, and status stuck on "running". The root cause traced
// to agent-relay: rollback steps landed in the relay's final result but
// were never streamed via the SSE `step` events, so a connection that goes
// quiet for the whole rollback duration (and drops before the trailing
// `done` event ships, e.g. via a proxy idle-timeout) leaves deploy-panel's
// locally-accumulated step log without them. This file exercises the REAL
// streamDeploy()/handleEvent() SSE-parsing path (not a mock of streamDeploy
// itself) against a stream shaped the way a fixed relay now emits it: step
// events for the rollback steps too, so they survive even when `done`
// never arrives.

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
  return {
    ...actual,
    // Only recoverBrokenDeploy is stubbed; the active-deploy registry and
    // readExistingSteps are kept real (via spread). recoverBrokenDeploy is
    // a plain async function in production (never throws synchronously),
    // so streamDeploy calls it directly without a Promise.resolve()
    // wrapper. The mock must resolve a real promise to match: a bare
    // vi.fn() returns undefined, and undefined.catch(...) would throw in
    // streamDeploy's catch block.
    recoverBrokenDeploy: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../src/lib/post-deploy-gate.js", () => ({
  verifyDeployHealth: vi.fn().mockResolvedValue({ healthy: true }),
}));

import { prisma } from "../src/lib/prisma.js";
import { recoverBrokenDeploy } from "../src/lib/deploy-recovery.js";
import { streamDeploy } from "../src/lib/stream-deploy.js";

const mAppFindUnique = (prisma.app as any).findUnique as ReturnType<typeof vi.fn>;
const mDeployFindUnique = (prisma.deploy as any).findUnique as ReturnType<typeof vi.fn>;
const mDeployUpdate = (prisma.deploy as any).update as ReturnType<typeof vi.fn>;
const mAppUpdate = (prisma.app as any).update as ReturnType<typeof vi.fn>;

const lastCall = (m: ReturnType<typeof vi.fn>) => m.mock.calls[m.mock.calls.length - 1][0];

const baseOpts = {
  serverId: "srv-a",
  deployId: "d1",
  appId: "app-1",
  appName: "project-forge",
  relayUrl: "http://relay.example",
  relayToken: null,
  body: {},
};

type SseEvent = { event: string; data: unknown };

function sseResponse(events: SseEvent[]): Response {
  const encoder = new TextEncoder();
  const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    body,
    headers: new Headers({ "content-type": "text/event-stream" }),
  } as unknown as Response;
}

// Delivers each string as its OWN chunk (its own `reader.read()` result),
// unlike sseResponse's single combined chunk — for exercising the reader
// loop's handling of a frame split across chunk boundaries.
function sseResponseChunked(textChunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of textChunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    body,
    headers: new Headers({ "content-type": "text/event-stream" }),
  } as unknown as Response;
}

const rollbackSteps: SseEvent[] = [
  { event: "step", data: { name: "rollback: git reset", status: "success", durationMs: 10 } },
  { event: "step", data: { name: "rollback: preflight", status: "success", durationMs: 5 } },
  { event: "step", data: { name: "rollback: compose build", status: "success", durationMs: 900 } },
  { event: "step", data: { name: "rollback: compose up", status: "success", durationMs: 300 } },
];

const healthCheckFailStep: SseEvent = {
  event: "step",
  data: {
    name: "health check",
    status: "failure",
    durationMs: 22525,
    output:
      "Health check failed: no service responded on /health after 5 attempts — last probe (app:3000/health): HTTP_STATUS=500\n\nContainer logs (last 50 lines, app):\napp | Error: relation \"tokens\" does not exist",
  },
};

describe("streamDeploy — rollback visibility + terminal status on health-check failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mAppFindUnique.mockResolvedValue({ requiredEnvKeys: [] });

    // Real Prisma reflects whatever was last written; a static mock would
    // not, so wire deploy.findUnique to track deploy.update's own writes.
    // Without this, the "stream ended without done" fallback below (which
    // reads current status to decide whether to finalize) would ALWAYS see
    // the stale initial "running" and double-finalize even after a `done`
    // event already wrote the real terminal status, masking the very bug
    // this file exists to catch.
    let currentStatus = "running";
    mDeployUpdate.mockImplementation(async (args: any) => {
      if (args?.data?.status) currentStatus = args.data.status;
      return {};
    });
    mDeployFindUnique.mockImplementation(async () => ({ status: currentStatus }));
  });

  // This test's `done` event carries its OWN `steps` array (rollback steps +
  // enriched health-check output already included), and finalizeDeploy uses
  // `data.steps ?? steps` — the relay's array wins outright. So this only
  // guards finalizeDeploy's done-event passthrough (ends failed, not stuck
  // running, whatever `data.steps` says survives verbatim); it does NOT
  // exercise handleEvent's own step-accumulator, which only matters on the
  // no-done path below. Passes even with the handleEvent output-carry fix
  // reverted — do not read it as coverage for that fix.
  it("passes through the relay's own `done`-event steps array unchanged, ending failed not stuck running", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        { event: "step", data: { name: "compose up", status: "success", durationMs: 21252 } },
        healthCheckFailStep,
        ...rollbackSteps,
        {
          event: "done",
          data: {
            success: false,
            commitBefore: "aaaa111",
            commitAfter: "aaaa111",
            durationMs: 45000,
            steps: [
              { name: "compose up", status: "success", durationMs: 21252 },
              healthCheckFailStep.data,
              ...rollbackSteps.map((s) => s.data),
            ],
          },
        },
      ]),
    );

    await streamDeploy(baseOpts);

    expect(lastCall(mDeployUpdate).data.status).toBe("failed");
    expect(lastCall(mDeployUpdate).data.commitBefore).toBe("aaaa111");
    expect(lastCall(mDeployUpdate).data.commitAfter).toBe("aaaa111");
    expect(lastCall(mAppUpdate).data.status).toBe("unhealthy");

    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    const rollbackNames = steps.filter((s: any) => s.name.startsWith("rollback:")).map((s: any) => s.name);
    expect(rollbackNames).toEqual([
      "rollback: git reset",
      "rollback: preflight",
      "rollback: compose build",
      "rollback: compose up",
    ]);
    const healthStep = steps.find((s: any) => s.name === "health check");
    expect(healthStep.output).toContain("HTTP_STATUS=500");
    expect(healthStep.output).toContain('relation "tokens" does not exist');

    fetchSpy.mockRestore();
  });

  // This is the exact incident shape: the relay streams the rollback steps
  // (proving the onStep fix landed) but the connection closes before a
  // `done` event ever arrives — e.g. a proxy idle-timeout during the long
  // silent-looking rollback. Recovery-by-exception (recoverBrokenDeploy)
  // does NOT fire here because no error was thrown; the reader loop's own
  // "stream ended without done" fallback must terminate the deploy.
  it("still ends failed, with the rollback steps intact, when the stream closes before a `done` event ever arrives", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        { event: "step", data: { name: "compose up", status: "success", durationMs: 21252 } },
        healthCheckFailStep,
        ...rollbackSteps,
        // No `done` event — the connection closes here.
      ]),
    );

    await streamDeploy(baseOpts);

    expect(recoverBrokenDeploy).not.toHaveBeenCalled();
    expect(lastCall(mDeployUpdate).data.status).toBe("failed");
    expect(lastCall(mDeployUpdate).data.status).not.toBe("running");

    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    const rollbackNames = steps.filter((s: any) => s.name.startsWith("rollback:")).map((s: any) => s.name);
    expect(rollbackNames).toEqual([
      "rollback: git reset",
      "rollback: preflight",
      "rollback: compose build",
      "rollback: compose up",
    ]);
    // The `step` event's own output was dropped by handleEvent on this
    // no-done path (the `done` event's `steps` array bypasses handleEvent's
    // accumulator entirely, so that path never showed this loss) — this is
    // the exact incident shape: the persisted health-check step lost its
    // diagnosis.
    const healthStep = steps.find((s: any) => s.name === "health check");
    expect(healthStep.output).toContain("HTTP_STATUS=500");

    fetchSpy.mockRestore();
  });

  it("leaves a successful deploy (no health failure, no rollback) unchanged", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponse([
        { event: "step", data: { name: "compose up", status: "success", durationMs: 5000 } },
        { event: "step", data: { name: "health check", status: "success", durationMs: 200 } },
        {
          event: "done",
          data: {
            success: true,
            commitBefore: "aaaa111",
            commitAfter: "bbbb222",
            durationMs: 6000,
            steps: [
              { name: "compose up", status: "success", durationMs: 5000 },
              { name: "health check", status: "success", durationMs: 200 },
            ],
          },
        },
      ]),
    );

    await streamDeploy(baseOpts);

    expect(lastCall(mDeployUpdate).data.status).toBe("success");
    expect(lastCall(mAppUpdate).data.status).toBe("healthy");
    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps.some((s: any) => s.name.startsWith("rollback:"))).toBe(false);

    fetchSpy.mockRestore();
  });

  // The reader loop used to declare `eventType` INSIDE the while body, so
  // an `event: `/`data: ` pair split across two chunks lost the event: the
  // `event: step` line was parsed and remembered in one read() call, but the
  // next read() call's iteration reset eventType to "" before the `data: `
  // line for that same event arrived, so the `data: ` branch's `&&
  // eventType` guard silently dropped it. Frames are ~4KB+ now that step
  // output carries diagnostic text, so this is no longer a corner case.
  it("still parses a step whose event/data lines are split across two stream chunks", async () => {
    const step = { name: "health check", status: "failure", durationMs: 22525, output: "HTTP_STATUS=500" };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sseResponseChunked([
        // Chunk 1 ends right after a complete "event: " line.
        "event: step\n",
        // Chunk 2 carries the "data: " line for that same event.
        `data: ${JSON.stringify(step)}\n\n`,
      ]),
    );

    await streamDeploy(baseOpts);

    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps).toEqual([step]);

    fetchSpy.mockRestore();
  });
});
