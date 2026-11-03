import { describe, expect, it, vi, beforeEach } from "vitest";

// A stream that closes cleanly without a `done` event: streamDeploy infers the
// outcome from the accumulated steps. The relay's best-effort `build cache
// prune` step must not decide that inference (any status), mirroring
// recoverBrokenDeploy. Rule under test, stated once:
//  - prune step ignored (any status);
//  - at least one non-prune step must exist (a prune-only list is NOT success);
//  - a failed step or a rollback* step vetoes success;
//  - every remaining step must be success or skipped.

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
import { BUILD_CACHE_PRUNE_STEP_NAME } from "../src/lib/deploy-recovery.js";
import { streamDeploy } from "../src/lib/stream-deploy.js";

const mAppFindUnique = (prisma.app as any).findUnique as ReturnType<typeof vi.fn>;
const mDeployFindUnique = (prisma.deploy as any).findUnique as ReturnType<typeof vi.fn>;
const mDeployUpdate = (prisma.deploy as any).update as ReturnType<typeof vi.fn>;

const opts = {
  serverId: "srv-a",
  deployId: "d1",
  appId: "app-1",
  appName: "my-app",
  relayUrl: "http://relay.example",
  relayToken: null,
  body: {},
};

type Step = { name: string; status: string; durationMs: number };
const step = (name: string, status: string): Step => ({ name, status, durationMs: 1 });

function closedWithoutDone(steps: Step[]): Response {
  const encoder = new TextEncoder();
  const text = steps.map((s) => `event: step\ndata: ${JSON.stringify(s)}\n\n`).join("");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return { ok: true, status: 200, body, headers: new Headers({ "content-type": "text/event-stream" }) } as unknown as Response;
}

async function finalStatus(steps: Step[]): Promise<string> {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(closedWithoutDone(steps));
  await streamDeploy(opts);
  fetchSpy.mockRestore();
  return mDeployUpdate.mock.calls[mDeployUpdate.mock.calls.length - 1][0].data.status;
}

describe("streamDeploy: stream ended without done ignores the best-effort prune step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mAppFindUnique.mockResolvedValue({ requiredEnvKeys: [] });
    let currentStatus = "running";
    mDeployUpdate.mockImplementation(async (args: any) => {
      if (args?.data?.status) currentStatus = args.data.status;
      return {};
    });
    mDeployFindUnique.mockImplementation(async () => ({ status: currentStatus }));
  });

  it("(a) all other steps success + failed prune -> success", async () => {
    expect(await finalStatus([step("compose up", "success"), step("health check", "success"), step(BUILD_CACHE_PRUNE_STEP_NAME, "failure")])).toBe("success");
  });

  it("(b) a real failed step + failed prune -> failed", async () => {
    expect(await finalStatus([step("compose up", "failure"), step(BUILD_CACHE_PRUNE_STEP_NAME, "failure")])).toBe("failed");
  });

  it("(c) skipped prune -> success", async () => {
    expect(await finalStatus([step("compose up", "success"), step(BUILD_CACHE_PRUNE_STEP_NAME, "skipped")])).toBe("success");
  });

  it("(d) a list holding only the prune step is not success", async () => {
    expect(await finalStatus([step(BUILD_CACHE_PRUNE_STEP_NAME, "success")])).toBe("failed");
  });

  it("(d2) an empty step list is still not success", async () => {
    expect(await finalStatus([])).toBe("failed");
  });

  it("(e) a rollback step vetoes success even when it reports success", async () => {
    expect(await finalStatus([step("compose up", "success"), step("rollback: compose up", "success"), step(BUILD_CACHE_PRUNE_STEP_NAME, "success")])).toBe("failed");
  });

  it("(f) a non-prune step with an unknown status is not success", async () => {
    expect(await finalStatus([step("compose up", "success"), step("health check", "running")])).toBe("failed");
  });
});
