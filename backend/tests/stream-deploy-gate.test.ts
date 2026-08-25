import { describe, expect, it, vi, beforeEach } from "vitest";

// Focused on the NEW pre-deploy gate wired into streamDeploy(): provisioning
// panel-managed secrets into the relay's .env before compose runs, and
// hard-blocking the deploy (never reaching the relay's /deploy endpoint) when
// a declared-required env key still resolves empty afterwards. The SSE/JSON
// event-handling behavior of streamDeploy is exercised by
// apps-name-validation.test.ts / v1-api.test.ts at the route level (which
// mock streamDeploy itself) — this file is the one place the real function
// runs, scoped to the gate.

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    app: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    deploy: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../src/lib/provision-secrets.js", () => ({
  provisionAndCheckAppSecrets: vi.fn(),
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

// finalizeDeploy (invoked once streamDeploy gets past the gate and the relay
// deploy call succeeds) runs the post-deploy health gate — mock it out so
// this file stays hermetic and scoped to the pre-deploy provisioning gate.
vi.mock("../src/lib/post-deploy-gate.js", () => ({
  verifyDeployHealth: vi.fn().mockResolvedValue({ healthy: true }),
}));

import { prisma } from "../src/lib/prisma.js";
import { provisionAndCheckAppSecrets } from "../src/lib/provision-secrets.js";
import { recoverBrokenDeploy } from "../src/lib/deploy-recovery.js";
import { streamDeploy } from "../src/lib/stream-deploy.js";

const mAppFindUnique = (prisma.app as any).findUnique as ReturnType<typeof vi.fn>;
const mAppUpdate = (prisma.app as any).update as ReturnType<typeof vi.fn>;
const mDeployUpdate = (prisma.deploy as any).update as ReturnType<typeof vi.fn>;
const mProvision = provisionAndCheckAppSecrets as unknown as ReturnType<typeof vi.fn>;

const lastCall = (m: ReturnType<typeof vi.fn>) => m.mock.calls[m.mock.calls.length - 1][0];

const baseOpts = {
  serverId: "srv-a",
  deployId: "d1",
  appId: "app-1",
  appName: "thd",
  relayUrl: "http://relay.example",
  relayToken: null,
  body: {},
};

describe("streamDeploy — pre-deploy secret provisioning + required-env gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mAppFindUnique.mockResolvedValue({ requiredEnvKeys: ["METRICS_API_TOKEN"] });
  });

  it("blocks the deploy BEFORE calling the relay when a required key is still missing after provisioning", async () => {
    mProvision.mockResolvedValue({ provisionedKeys: [], wrote: false, missing: ["METRICS_API_TOKEN"] });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await streamDeploy(baseOpts);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lastCall(mDeployUpdate).data.status).toBe("failed");
    expect(lastCall(mAppUpdate).data.status).toBe("unhealthy");
    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps.at(-1)).toMatchObject({ name: "env-preflight", status: "failure" });
    expect(steps.at(-1).output).toContain("METRICS_API_TOKEN");
    expect(recoverBrokenDeploy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("proceeds to call the relay's deploy endpoint once provisioning leaves nothing missing", async () => {
    mProvision.mockResolvedValue({ provisionedKeys: ["METRICS_API_TOKEN"], wrote: true, missing: [] });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      body: {} as any,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ result: { success: true, steps: [] } }),
    } as unknown as Response);

    await streamDeploy(baseOpts);

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://relay.example/api/apps/thd/deploy?stream=true",
      expect.objectContaining({ method: "POST" }),
    );

    fetchSpy.mockRestore();
  });

  it("passes requiredEnvKeys from the app row into provisioning, defaulting to [] when the app has none declared", async () => {
    mAppFindUnique.mockResolvedValue({ requiredEnvKeys: [] });
    mProvision.mockResolvedValue({ provisionedKeys: [], wrote: false, missing: [] });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      body: {} as any,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ result: { success: true, steps: [] } }),
    } as unknown as Response);

    await streamDeploy(baseOpts);

    expect(mProvision).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "srv-a", appId: "app-1", appName: "thd", requiredKeys: [] }),
    );

    fetchSpy.mockRestore();
  });

  it("records which panel-managed secrets were (re)provisioned by key name only, never a value", async () => {
    mProvision.mockResolvedValue({ provisionedKeys: ["METRICS_API_TOKEN"], wrote: true, missing: [] });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      body: {} as any,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ result: { success: true, steps: [] } }),
    } as unknown as Response);

    await streamDeploy(baseOpts);

    const deployUpdateData = mDeployUpdate.mock.calls[0]?.[0]?.data;
    expect(deployUpdateData?.log).toContain("provision-secrets");
    expect(deployUpdateData?.log).toContain("METRICS_API_TOKEN");

    fetchSpy.mockRestore();
  });
});

// A relay 4xx response means the relay received and definitively rejected
// the deploy request, not a connection that dropped mid-flight. Routing
// that into recoverBrokenDeploy would run the post-deploy health probe
// against whatever the PREVIOUS successful deploy left running, greenwashing
// a real rejection into a "success" row (the bug PR #124 fixed for
// rollback: routes/v1.ts and routes/apps.ts's rollback routes). These tests
// pin the fix and its boundary (5xx / no-body / network errors still route
// through the existing recovery path).
describe("streamDeploy: relay response handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mAppFindUnique.mockResolvedValue({ requiredEnvKeys: [] });
    mProvision.mockResolvedValue({ provisionedKeys: [], wrote: false, missing: [] });
  });

  it("relay 404 (unknown app): marks the deploy failed without recovery, and the reason round-trips as a visible step", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      body: null,
      headers: new Headers(),
      text: async () => "unknown app",
    } as unknown as Response);

    await streamDeploy(baseOpts);

    expect(lastCall(mDeployUpdate).data.status).toBe("failed");
    expect(lastCall(mAppUpdate).data.status).toBe("unhealthy");
    expect(recoverBrokenDeploy).not.toHaveBeenCalled();

    // GET /api/v1/deploy/:id and the panel-UI equivalent both
    // JSON.parse(deploy.log) inside a swallowing try/catch: a bare string
    // log fails that parse and surfaces as `steps: []`, hiding the reason.
    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(Array.isArray(steps)).toBe(true);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ name: "deploy", status: "failure", durationMs: 0 });
    expect(steps[0].output).toContain("404");
    expect(steps[0].output).toContain("unknown app");

    fetchSpy.mockRestore();
  });

  it("relay 400 (bad branch): marks the deploy failed without recovery", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      body: null,
      headers: new Headers(),
      text: async () => "unknown branch: does-not-exist",
    } as unknown as Response);

    await streamDeploy(baseOpts);

    expect(lastCall(mDeployUpdate).data.status).toBe("failed");
    expect(recoverBrokenDeploy).not.toHaveBeenCalled();
    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps[0].output).toContain("400");
    expect(steps[0].output).toContain("does-not-exist");

    fetchSpy.mockRestore();
  });

  it("relay 500: still routes through recoverBrokenDeploy (not the 4xx no-recovery path)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      body: null,
      headers: new Headers(),
      text: async () => "boom",
    } as unknown as Response);

    await streamDeploy(baseOpts);

    expect(recoverBrokenDeploy).toHaveBeenCalledOnce();
    expect(recoverBrokenDeploy).toHaveBeenCalledWith("d1", "app-1", "srv-a", "thd", expect.stringContaining("500"));

    fetchSpy.mockRestore();
  });

  it("network error (fetch rejects): still routes through recoverBrokenDeploy", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch failed"));

    await streamDeploy(baseOpts);

    expect(recoverBrokenDeploy).toHaveBeenCalledOnce();
    expect(mDeployUpdate).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("relay JSON fallback with an unparseable body: stores the failure reason as a JSON step array, not a bare string", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      body: {} as any,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => {
        throw new Error("invalid json");
      },
    } as unknown as Response);

    await streamDeploy(baseOpts);

    expect(lastCall(mDeployUpdate).data.status).toBe("failed");
    expect(lastCall(mAppUpdate).data.status).toBe("unhealthy");
    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ name: "deploy", status: "failure" });
    expect(steps[0].output).toBe("Relay returned invalid JSON");

    fetchSpy.mockRestore();
  });

  function sseResponse(body: string, status = 200): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });
    return {
      ok: status < 400,
      status,
      body: stream,
      headers: new Headers({ "content-type": "text/event-stream" }),
      text: async () => body,
    } as unknown as Response;
  }

  it("SSE `error` event: stores the relay message as a JSON step array, not a bare string", async () => {
    const sse = 'event: error\ndata: {"message":"Deploy script exited with code 1"}\n\n';
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(sse));

    await streamDeploy(baseOpts);

    expect(lastCall(mDeployUpdate).data.status).toBe("failed");
    expect(lastCall(mAppUpdate).data.status).toBe("unhealthy");
    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ name: "deploy", status: "failure" });
    expect(steps[0].output).toBe("Deploy script exited with code 1");

    fetchSpy.mockRestore();
  });
});
