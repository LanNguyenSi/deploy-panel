import { describe, expect, it, vi, beforeEach } from "vitest";

// Task 1f6895f6, fix round 3: recoverBrokenDeploy used to REPLACE deploy.log
// with a synthetic 2-step array and could mark a rolled-back deploy
// success/healthy purely because a post-recovery probe found the app
// healthy — but a healthy probe right after a rollback proves the OLD
// version is back up, not that this deploy succeeded. This file exercises
// the REAL streamDeploy() -> (real, unmocked) recoverBrokenDeploy() path
// end to end against an undici-style abrupt stream termination
// (`TypeError: terminated`, the shape the reviewer reproduced) that hits
// AFTER the rollback steps have already streamed, with the post-recovery
// probe reporting healthy. It asserts the deploy is recorded failed (not
// success), the rollback steps survive into the final log, and the
// health-check step's enriched output survives too — i.e. recovery APPENDS
// to what streamDeploy already accumulated instead of replacing it.

const { getRecoveryPromise, setRecoveryPromise } = vi.hoisted(() => {
  let promise: Promise<void> | null = null;
  return {
    setRecoveryPromise: (p: Promise<void>) => {
      promise = p;
    },
    getRecoveryPromise: () => promise,
  };
});

vi.mock("../src/lib/deploy-recovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/deploy-recovery.js")>();
  return {
    ...actual,
    // Wrap (not replace) the real implementation: streamDeploy fires
    // recoverBrokenDeploy without awaiting it, so the test needs a handle on
    // its promise to know when recovery has actually finished writing.
    recoverBrokenDeploy: vi.fn((...args: Parameters<typeof actual.recoverBrokenDeploy>) => {
      const p = actual.recoverBrokenDeploy(...args);
      setRecoveryPromise(p);
      return p;
    }),
  };
});

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    app: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    deploy: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../src/lib/provision-secrets.js", () => ({
  provisionAndCheckAppSecrets: vi.fn().mockResolvedValue({ provisionedKeys: [], wrote: false, missing: [] }),
}));

vi.mock("../src/lib/post-deploy-gate.js", () => ({
  verifyDeployHealth: vi.fn(),
}));

import { prisma } from "../src/lib/prisma.js";
import { verifyDeployHealth } from "../src/lib/post-deploy-gate.js";
import { streamDeploy } from "../src/lib/stream-deploy.js";

const mAppFindUnique = (prisma.app as any).findUnique as ReturnType<typeof vi.fn>;
const mDeployFindUnique = (prisma.deploy as any).findUnique as ReturnType<typeof vi.fn>;
const mDeployUpdate = (prisma.deploy as any).update as ReturnType<typeof vi.fn>;
const mAppUpdate = (prisma.app as any).update as ReturnType<typeof vi.fn>;
const mGate = verifyDeployHealth as unknown as ReturnType<typeof vi.fn>;

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

const healthCheckFailStep = {
  name: "health check",
  status: "failure",
  durationMs: 22525,
  output:
    "Health check failed: no service responded on /health after 5 attempts — last probe (app:3000/health): HTTP_STATUS=500",
};

const rollbackSteps = [
  { name: "rollback: git reset", status: "success", durationMs: 10 },
  { name: "rollback: preflight", status: "success", durationMs: 5 },
  { name: "rollback: compose build", status: "success", durationMs: 900 },
  { name: "rollback: compose up", status: "success", durationMs: 300 },
];

/**
 * Pull-based (not start-based) SSE stream: each `pull()` call delivers the
 * next step frame, so the reader loop actually consumes every chunk before
 * the stream errors on the call after the last one — a start()-based stream
 * that enqueues everything then calls controller.error() synchronously would
 * discard the whole queue instead (the Streams spec clears it on error).
 */
function sseThenAbruptlyTerminate(steps: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < steps.length) {
        const step = steps[index++];
        controller.enqueue(encoder.encode(`event: step\ndata: ${JSON.stringify(step)}\n\n`));
        return;
      }
      // undici-style abrupt termination mid-body: no `done` event, no clean
      // stream close, the reader's read() rejects with this.
      controller.error(new TypeError("terminated"));
    },
  });
  return {
    ok: true,
    status: 200,
    body,
    headers: new Headers({ "content-type": "text/event-stream" }),
  } as unknown as Response;
}

describe("streamDeploy -> recoverBrokenDeploy — append + rollback-aware success refusal on abrupt stream termination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mAppFindUnique.mockResolvedValue({ requiredEnvKeys: [], liveUrl: null });

    // Fake DB: reflects whatever the mocked update calls last wrote, so
    // recoverBrokenDeploy's own deploy.findUnique read-back sees exactly
    // what streamDeploy's handleEvent had already persisted per step.
    let currentStatus = "running";
    let currentLog: string | null = null;
    mDeployUpdate.mockImplementation(async (args: any) => {
      if (args?.data?.status) currentStatus = args.data.status;
      if (typeof args?.data?.log === "string") currentLog = args.data.log;
      return {};
    });
    mDeployFindUnique.mockImplementation(async () => ({ status: currentStatus, log: currentLog }));
  });

  it("records the deploy failed, not success, preserving the rollback steps and the health-check step's enriched output, when the stream terminates mid-body after the rollback steps and the post-recovery probe finds the (rolled-back) app healthy", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(sseThenAbruptlyTerminate([healthCheckFailStep, ...rollbackSteps]));
    // The post-rollback probe genuinely finds the app healthy — it's the
    // OLD version, restored by rollback, that's answering.
    mGate.mockResolvedValue({ healthy: true });

    await streamDeploy(baseOpts);
    await getRecoveryPromise();

    expect(lastCall(mDeployUpdate).data.status).toBe("failed");
    expect(lastCall(mAppUpdate).data.status).toBe("healthy");

    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    const rollbackNames = steps.filter((s: any) => s.name?.startsWith?.("rollback:")).map((s: any) => s.name);
    expect(rollbackNames).toEqual(rollbackSteps.map((s) => s.name));

    const healthStep = steps.find((s: any) => s.name === "health check");
    expect(healthStep.output).toContain("HTTP_STATUS=500");

    fetchSpy.mockRestore();
  });
});
