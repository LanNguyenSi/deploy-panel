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
    deploy: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn().mockResolvedValue({}) },
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
import { blockedDeployLogSteps, blockedPreflightSteps, isBlockedDeployLog, normalizeDeployLog } from "../src/lib/deploy-log.js";

const mAppFindUnique = (prisma.app as any).findUnique as ReturnType<typeof vi.fn>;
const mAppUpdate = (prisma.app as any).update as ReturnType<typeof vi.fn>;
const mDeployUpdate = (prisma.deploy as any).update as ReturnType<typeof vi.fn>;
const mDeployFindMany = (prisma.deploy as any).findMany as ReturnType<typeof vi.fn>;
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
  const jsonResponse = (body: unknown) =>
    ({
      ok: true,
      status: 200,
      body: {} as any,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => body,
    }) as unknown as Response;
  const blockedPreflight = {
    passed: false,
    checks: [
      { name: "disk", passed: false, message: "disk almost full", critical: true },
      { name: "git", passed: true, message: "clean", critical: false },
    ],
  };

  // What the relay streams before it blocks: a passing pre-pull preflight, the pull, and the
  // post-pull preflight summary step that lists every check (passed ones included).
  const relayStreamSteps = [
    { name: "preflight (pre-pull)", status: "success", durationMs: 40, output: "\u2713 disk: ok" },
    { name: "git pull", status: "success", durationMs: 1300, output: "Updating a..b" },
    { name: "preflight (post-pull)", status: "failure", durationMs: 55, output: "\u2717 disk: disk almost full\n\u2713 git: clean" },
  ];
  const diskStep = { name: "disk", kind: "preflight-check", status: "failure", durationMs: 0, message: "disk almost full", output: "disk almost full", critical: true };

  it("JSON-blocked relay response: log is one failed step per failed check, app status is restored, deploy is failed", async () => {
    mProvision.mockResolvedValue({ provisionedKeys: [], wrote: false, missing: [] });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        result: { success: false, blocked: true, preflight: blockedPreflight, durationMs: 3, commitBefore: "a", commitAfter: "a", steps: relayStreamSteps },
      }),
    );

    await streamDeploy({ ...baseOpts, previousStatus: "healthy" });

    const update = lastCall(mDeployUpdate);
    expect(update.data.status).toBe("failed");
    // the relay's own steps are kept, minus its failed preflight summary step
    expect(JSON.parse(update.data.log)).toEqual([...relayStreamSteps.slice(0, 2), diskStep]);
    expect(update.data.commitBefore).toBe("a");
    expect(update.data.commitAfter).toBe("a");
    expect(update.data.duration).toBe(3);
    expect(lastCall(mAppUpdate).data).toEqual({ status: "healthy" });
    expect(lastCall(mAppUpdate).data.lastDeployAt).toBeUndefined();

    fetchSpy.mockRestore();
  });

  it("JSON-blocked relay response with empty steps and no duration: still the failed-check steps, duration measured locally", async () => {
    mProvision.mockResolvedValue({ provisionedKeys: [], wrote: false, missing: [] });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ result: { success: false, blocked: true, preflight: blockedPreflight, steps: [] } }),
    );

    await streamDeploy({ ...baseOpts, previousStatus: "unhealthy" });

    const update = lastCall(mDeployUpdate);
    expect(update.data.status).toBe("failed");
    expect(JSON.parse(update.data.log)).toEqual([diskStep]);
    expect(typeof update.data.duration).toBe("number");
    expect(update.data.commitBefore).toBeNull();
    expect(lastCall(mAppUpdate).data).toEqual({ status: "unhealthy" });

    fetchSpy.mockRestore();
  });

  it("SSE `blocked` event: same log shape as the JSON path, app status restored, prior steps kept in front", async () => {
    mProvision.mockResolvedValue({
      provisionedKeys: ["A"],
      wrote: true,
      missing: [],
    });
    const sse =
      relayStreamSteps.map((st) => `event: step\ndata: ${JSON.stringify(st)}\n\n`).join("") +
      `event: blocked\ndata: ${JSON.stringify(blockedPreflight)}\n\n`;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(sse));

    await streamDeploy({ ...baseOpts, previousStatus: "healthy" });

    const update = lastCall(mDeployUpdate);
    expect(update.data.status).toBe("failed");
    const steps = JSON.parse(update.data.log);
    // the relay's failed preflight summary step is dropped: its output repeats every check, passed ones too
    expect(steps.map((s: any) => s.name)).toEqual(["provision-secrets", "preflight (pre-pull)", "git pull", "disk"]);
    expect(steps[3]).toEqual(diskStep);
    expect(steps.filter((s: any) => s.kind === "preflight-check")).toHaveLength(1);
    expect(typeof update.data.duration).toBe("number");
    expect(lastCall(mAppUpdate).data).toEqual({ status: "healthy" });
    // the stream-end fallback must not overwrite the blocked outcome
    expect(mAppUpdate.mock.calls.some((c) => c[0].data.lastDeployAt)).toBe(false);

    fetchSpy.mockRestore();
  });

  it("SSE `blocked` event with no per-check data: log is a single failed preflight step, never empty or a bare object", async () => {
    mProvision.mockResolvedValue({ provisionedKeys: [], wrote: false, missing: [] });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse("event: blocked\ndata: {}\n\n"));

    await streamDeploy({ ...baseOpts, previousStatus: "healthy" });

    const steps = JSON.parse(lastCall(mDeployUpdate).data.log);
    expect(steps).toEqual([expect.objectContaining({ name: "preflight", status: "failure", output: "Blocked by preflight" })]);

    fetchSpy.mockRestore();
  });

  describe("status restored after a blocked deploy", () => {
    const blockedSse = () => sseResponse(`event: blocked\ndata: ${JSON.stringify(blockedPreflight)}\n\n`);
    const okLog = JSON.stringify([{ name: "deploy", status: "success", durationMs: 1 }]);
    const failedLog = JSON.stringify([{ name: "deploy", status: "failure", durationMs: 1, output: "boom" }]);
    const blockedLog = JSON.stringify(blockedPreflightSteps(blockedPreflight));
    const oldBlockedLog = JSON.stringify(blockedPreflight);

    beforeEach(() => {
      mProvision.mockResolvedValue({ provisionedKeys: [], wrote: false, missing: [] });
    });

    it("explicit previousStatus wins over the deploy history", async () => {
      mDeployFindMany.mockResolvedValue([{ status: "failed", log: failedLog }]);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(blockedSse());
      await streamDeploy({ ...baseOpts, previousStatus: "healthy" });
      expect(lastCall(mAppUpdate).data).toEqual({ status: "healthy" });
      expect(mDeployFindMany).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("no previousStatus, last other deploy succeeded: healthy", async () => {
      mDeployFindMany.mockResolvedValue([{ status: "success", log: okLog }]);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(blockedSse());
      await streamDeploy(baseOpts);
      expect(lastCall(mAppUpdate).data).toEqual({ status: "healthy" });
      expect(lastCall(mDeployFindMany).where).toMatchObject({ appId: "app-1", id: { not: "d1" } });
      fetchSpy.mockRestore();
    });

    it("no previousStatus, last other deploy really failed: unhealthy", async () => {
      mDeployFindMany.mockResolvedValue([{ status: "failed", log: failedLog }]);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(blockedSse());
      await streamDeploy(baseOpts);
      expect(lastCall(mAppUpdate).data).toEqual({ status: "unhealthy" });
      fetchSpy.mockRestore();
    });

    it("no previousStatus and no earlier deploy: unknown", async () => {
      mDeployFindMany.mockResolvedValue([]);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(blockedSse());
      await streamDeploy(baseOpts);
      expect(lastCall(mAppUpdate).data).toEqual({ status: "unknown" });
      fetchSpy.mockRestore();
    });

    it("no previousStatus, history lookup fails: unknown", async () => {
      mDeployFindMany.mockRejectedValue(new Error("db down"));
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(blockedSse());
      await streamDeploy(baseOpts);
      expect(lastCall(mAppUpdate).data).toEqual({ status: "unknown" });
      fetchSpy.mockRestore();
    });

    it("no previousStatus: earlier blocked deploys (new and old log shape) are skipped, a healthy app stays healthy", async () => {
      // newest first: two blocked deploys (marked steps, then the old raw report), then the last real success
      mDeployFindMany.mockResolvedValue([
        { status: "failed", log: blockedLog },
        { status: "failed", log: oldBlockedLog },
        { status: "success", log: okLog },
      ]);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(blockedSse());
      await streamDeploy(baseOpts);
      expect(lastCall(mAppUpdate).data).toEqual({ status: "healthy" });
      // the lookup must reach past the newest deploy, and read the log it judges by
      expect(lastCall(mDeployFindMany).take).toBeGreaterThanOrEqual(3);
      expect(lastCall(mDeployFindMany).select).toMatchObject({ status: true, log: true });
      fetchSpy.mockRestore();
    });

    it("no previousStatus: a real failure behind a blocked deploy still maps to unhealthy", async () => {
      mDeployFindMany.mockResolvedValue([
        { status: "failed", log: blockedLog },
        { status: "failed", log: failedLog },
        { status: "success", log: okLog },
      ]);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(blockedSse());
      await streamDeploy(baseOpts);
      expect(lastCall(mAppUpdate).data).toEqual({ status: "unhealthy" });
      fetchSpy.mockRestore();
    });

    it("no previousStatus and only blocked deploys in the history: unknown", async () => {
      mDeployFindMany.mockResolvedValue([{ status: "failed", log: blockedLog }]);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(blockedSse());
      await streamDeploy(baseOpts);
      expect(lastCall(mAppUpdate).data).toEqual({ status: "unknown" });
      fetchSpy.mockRestore();
    });

    it("previousStatus `deploying` (overlapping deploy) is not restored; falls back to history", async () => {
      mDeployFindMany.mockResolvedValue([{ status: "success", log: okLog }]);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(blockedSse());
      await streamDeploy({ ...baseOpts, previousStatus: "deploying" });
      expect(lastCall(mAppUpdate).data).toEqual({ status: "healthy" });
      fetchSpy.mockRestore();
    });
  });
});

describe("deploy-log helpers", () => {
  const report = { passed: false, checks: [{ name: "disk", passed: false, message: "full", critical: true }] };

  it("every step of a blocked log carries the preflight-check marker, including the generic fallback step", () => {
    expect(blockedPreflightSteps(report).every((s) => s.kind === "preflight-check")).toBe(true);
    expect(blockedPreflightSteps({})[0].kind).toBe("preflight-check");
  });

  it("isBlockedDeployLog: marked steps array and old raw report are blocked; real failures and junk are not", () => {
    expect(isBlockedDeployLog(JSON.stringify(blockedPreflightSteps(report)))).toBe(true);
    expect(isBlockedDeployLog(JSON.stringify([{ name: "x", status: "success" }, ...blockedPreflightSteps(report)]))).toBe(true);
    expect(isBlockedDeployLog(JSON.stringify(report))).toBe(true);
    expect(isBlockedDeployLog(JSON.stringify([{ name: "preflight", status: "failure", durationMs: 0 }]))).toBe(false);
    expect(isBlockedDeployLog(JSON.stringify([{ name: "deploy", status: "failure", durationMs: 0, output: "boom" }]))).toBe(false);
    expect(isBlockedDeployLog(JSON.stringify("blocked by preflight"))).toBe(false);
    expect(isBlockedDeployLog("not json")).toBe(false);
    expect(isBlockedDeployLog(null)).toBe(false);
    expect(isBlockedDeployLog("")).toBe(false);
  });

  it("blockedDeployLogSteps drops only a failed relay preflight summary step, keeps passed ones and other steps", () => {
    const before = [
      { name: "preflight (pre-pull)", status: "success", durationMs: 1 },
      { name: "preflight", status: "failure", durationMs: 1 },
      { name: "preflight (post-pull)", status: "failure", durationMs: 1 },
      { name: "preflight-extra", status: "failure", durationMs: 1 },
      { name: "git pull", status: "success", durationMs: 1 },
    ];
    expect(blockedDeployLogSteps(before, report).map((s) => s.name)).toEqual([
      "preflight (pre-pull)",
      "preflight-extra",
      "git pull",
      "disk",
    ]);
    expect(blockedDeployLogSteps(undefined, report).map((s) => s.name)).toEqual(["disk"]);
  });
});

describe("blockedPreflightSteps / normalizeDeployLog", () => {
  it("emits only failed checks, carrying name, message and the critical flag", () => {
    expect(
      blockedPreflightSteps({
        passed: false,
        checks: [
          { name: "a", passed: true, message: "ok", critical: true },
          { name: "b", passed: false, message: "bad", critical: false },
        ],
      }),
    ).toEqual([{ name: "b", kind: "preflight-check", status: "failure", durationMs: 0, message: "bad", output: "bad", critical: false }]);
  });

  it("falls back to one generic step for a non-report payload", () => {
    for (const bad of [undefined, null, "x", {}, { checks: [] }, { checks: [{ name: "a", passed: true, message: "ok" }] }]) {
      expect(blockedPreflightSteps(bad)).toHaveLength(1);
    }
  });

  it("normalizeDeployLog: array, string, preflight report and other objects", () => {
    const arr = [{ name: "s", status: "success", durationMs: 1 }];
    expect(normalizeDeployLog(arr)).toBe(arr);
    expect(normalizeDeployLog("blocked by preflight")).toEqual([
      { name: "deploy", status: "failure", durationMs: 0, output: "blocked by preflight" },
    ]);
    expect(
      normalizeDeployLog({ passed: false, checks: [{ name: "disk", passed: false, message: "full", critical: true }] }),
    ).toEqual([expect.objectContaining({ name: "disk", status: "failure", output: "full" })]);
    const rollback = { success: true, commitBefore: "a" };
    expect(normalizeDeployLog(rollback)).toEqual([rollback]);
  });
});
