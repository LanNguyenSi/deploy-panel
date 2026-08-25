import { describe, expect, it, vi, beforeEach } from "vitest";

// agent-relay answers POST /api/apps/:name/rollback with HTTP 200 in every
// case (blocked, failed, and succeeded) — see agent-relay src/api/routes.ts.
// The response shape differs by outcome:
//
//   - blocked by preflight:      { result: { success: false, blocked: true, preflight, commitBefore, commitAfter } }
//   - completed (success or a
//     non-preflight failure):    { deploy, success, commitBefore, commitAfter, ... }  (spread at top level)
//
// These tests pin that the proxy route (apps.ts) reads BOTH shapes
// correctly: the deploy row's status/commits must reflect the actual
// outcome, and the JSON response returned to the frontend must carry
// `blocked`/`success`/`preflight` so the UI can render a real error
// instead of a blanket "Rollback triggered" success toast.

vi.mock("../src/lib/relay.js", () => ({
  relayRequest: vi.fn(),
  RelayError: class RelayError extends Error {
    status: number;
    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("../src/lib/ownership.js", () => ({
  getActorContext: vi.fn(() => ({ userId: "user-a", isAdmin: false })),
  findOwnedServer: vi.fn(async () => ({ id: "srv-a", userId: "user-a" })),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    app: { upsert: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    deploy: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("../src/lib/audit.js", () => ({
  audit: vi.fn(),
  getActor: vi.fn(() => "panel"),
  getActorUserId: vi.fn(() => "user-a"),
}));

vi.mock("../src/lib/deploy-recovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/deploy-recovery.js")>();
  return {
    ...actual,
    // Only recoverBrokenDeploy is stubbed. activeDeployIds and
    // readExistingSteps are kept real (via spread) rather than replaced by
    // a partial factory: a partial factory used to leave readExistingSteps
    // undefined here, which made startup.ts's recoverStuckDeploys throw
    // (swallowed by its per-record try/catch) before ever reaching
    // prisma.deploy.updateMany whenever a candidate row slipped past the
    // activeDeployIds exclusion, masking exactly the registration mutants
    // the "activeDeployIds registration" describe block below exists to
    // catch, since the assertion `updateMany not called` then passed for
    // the wrong reason.
    //
    // Resolves a real promise (not a bare vi.fn(), which returns
    // undefined): the route now calls `.catch(...)` on recoverBrokenDeploy's
    // return value (fire-and-forget with its own rejection guard), and
    // undefined.catch(...) throws.
    recoverBrokenDeploy: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("../src/lib/stream-deploy.js", () => ({ streamDeploy: vi.fn() }));

import { relayRequest, RelayError } from "../src/lib/relay.js";
import { prisma } from "../src/lib/prisma.js";
import { appsRouter } from "../src/routes/apps.js";
import { recoverBrokenDeploy, activeDeployIds } from "../src/lib/deploy-recovery.js";
import { recoverStuckDeploys } from "../src/lib/startup.js";
import { Hono } from "hono";

const mRelay = relayRequest as unknown as ReturnType<typeof vi.fn>;
const mAppUpsert = prisma.app.upsert as unknown as ReturnType<typeof vi.fn>;
const mDeployCreate = prisma.deploy.create as unknown as ReturnType<typeof vi.fn>;
const mDeployUpdate = prisma.deploy.update as unknown as ReturnType<typeof vi.fn>;
const mDeployUpdateMany = prisma.deploy.updateMany as unknown as ReturnType<typeof vi.fn>;
const mDeployFindMany = prisma.deploy.findMany as unknown as ReturnType<typeof vi.fn>;
const mRecoverBrokenDeploy = recoverBrokenDeploy as unknown as ReturnType<typeof vi.fn>;

function app() {
  const a = new Hono();
  a.route("/servers/:serverId/apps", appsRouter as unknown as Hono);
  return a;
}

const PREFLIGHT_BLOCKED = {
  passed: false,
  checks: [
    { name: "apps_root_mount_congruence", passed: true, message: "ok", critical: true },
    { name: "compose_bind_mount_sources_exist", passed: false, message: "bind mount source missing: /data/foo", critical: true },
  ],
};

describe("POST /:name/rollback — agent-relay result shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mAppUpsert.mockResolvedValue({ id: "app-a", name: "my-app" });
    mDeployCreate.mockResolvedValue({ id: "deploy-1", status: "running" });
    mDeployUpdate.mockResolvedValue({});
  });

  it("blocked by preflight: nested `result.result` is read, row is failed with commits + preflight preserved", async () => {
    mRelay.mockResolvedValueOnce({
      result: {
        success: false,
        blocked: true,
        preflight: PREFLIGHT_BLOCKED,
        commitBefore: "abc123",
        commitAfter: "abc123",
      },
    });

    const res = await app().request("/servers/srv-a/apps/my-app/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(mDeployUpdate).toHaveBeenCalledTimes(1);
    const updateData = mDeployUpdate.mock.calls[0][0].data;
    expect(updateData.status).toBe("failed");
    expect(updateData.commitBefore).toBe("abc123");
    expect(updateData.commitAfter).toBe("abc123");

    const body = await res.json();
    expect(body.deploy.blocked).toBe(true);
    expect(body.deploy.success).toBe(false);
    expect(body.deploy.preflight).toEqual(PREFLIGHT_BLOCKED);
  });

  it("relay-reported failure (not blocked): flat top-level shape is read, row is failed (defensive: not currently emitted by agent-relay — non-preflight failures are HTTP 400 { error }, see the RelayError describe block below)", async () => {
    mRelay.mockResolvedValueOnce({
      deploy: { id: "relay-deploy-1" },
      success: false,
      commitBefore: "abc123",
      commitAfter: "def456",
    });

    const res = await app().request("/servers/srv-a/apps/my-app/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const updateData = mDeployUpdate.mock.calls[0][0].data;
    expect(updateData.status).toBe("failed");
    expect(updateData.commitBefore).toBe("abc123");
    expect(updateData.commitAfter).toBe("def456");

    const body = await res.json();
    expect(body.deploy.success).toBe(false);
    expect(body.deploy.blocked).toBeUndefined();
  });

  it("positive case unchanged: flat top-level success shape marks the row rolled_back", async () => {
    mRelay.mockResolvedValueOnce({
      deploy: { id: "relay-deploy-1" },
      success: true,
      commitBefore: "abc123",
      commitAfter: "def456",
    });

    const res = await app().request("/servers/srv-a/apps/my-app/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const updateData = mDeployUpdate.mock.calls[0][0].data;
    expect(updateData.status).toBe("rolled_back");
    expect(updateData.commitBefore).toBe("abc123");
    expect(updateData.commitAfter).toBe("def456");

    const body = await res.json();
    expect(body.deploy.success).toBe(true);
  });
});

// The real reachable failure path: agent-relay answers a non-preflight
// rollback failure with HTTP 4xx `{ error }` (e.g. "no previous deploy to
// roll back to"), which relayRequest() turns into a thrown RelayError — it
// never reaches the try block's flat-shape branch above. Before this fix,
// every RelayError (regardless of status) was routed to recoverBrokenDeploy,
// whose post-deploy health probe can't distinguish "rollback never ran, app
// still healthy from the prior deploy" from "rollback succeeded" — a real,
// already-answered failure could end up recorded as a green success row.
describe("POST /:name/rollback — RelayError from the relay call itself", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mAppUpsert.mockResolvedValue({ id: "app-a", name: "my-app" });
    mDeployCreate.mockResolvedValue({ id: "deploy-1", status: "running" });
    mDeployUpdate.mockResolvedValue({});
  });

  it("4xx RelayError: deploy row is marked failed directly, the caller gets the relay's message, and recoverBrokenDeploy is NOT invoked", async () => {
    mRelay.mockRejectedValueOnce(new RelayError('Relay error (400): {"error":"no previous deploy to roll back to"}', 400));

    const res = await app().request("/servers/srv-a/apps/my-app/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("relay_error");
    expect(body.message).toContain("no previous deploy to roll back to");

    expect(mDeployUpdate).toHaveBeenCalledTimes(1);
    const updateData = mDeployUpdate.mock.calls[0][0].data;
    expect(updateData.status).toBe("failed");

    expect(mRecoverBrokenDeploy).not.toHaveBeenCalled();
  });

  it("5xx RelayError: still routed through recoverBrokenDeploy, not marked failed directly by the route", async () => {
    mRelay.mockRejectedValueOnce(new RelayError("Relay error (500): boom", 500));

    const res = await app().request("/servers/srv-a/apps/my-app/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("relay_error");
    expect(body.message).toContain("boom");

    expect(mRecoverBrokenDeploy).toHaveBeenCalledTimes(1);
    expect(mDeployUpdate).not.toHaveBeenCalled();
  });
});

// This route drives the deploy record itself (relayRequest, then a direct
// prisma.deploy.update) instead of going through streamDeploy, so its id
// used to never enter activeDeployIds: the periodic stuck-sweep
// (recoverStuckDeploys, startup.ts) could finalize a rollback that was
// still genuinely in flight once it aged past the 2-minute threshold. See
// deploy-panel#130.
describe("POST /:name/rollback: activeDeployIds registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeDeployIds.clear();
    mAppUpsert.mockResolvedValue({ id: "app-a", name: "my-app" });
    mDeployCreate.mockResolvedValue({ id: "rollback-guard-1", status: "running" });
    mDeployUpdate.mockResolvedValue({});
    mDeployUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("registers the deploy id while relayRequest is in flight, and a concurrent stuck-sweep pass does not finalize it", async () => {
    let releaseRelay!: (v: unknown) => void;
    mRelay.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRelay = resolve;
        }),
    );

    const requestPromise = app().request("/servers/srv-a/apps/my-app/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    await vi.waitFor(() => expect(mRelay).toHaveBeenCalledOnce());
    expect(activeDeployIds.has("rollback-guard-1")).toBe(true);

    // A concurrent stuck-sweep pass, run while the rollback is still
    // in-flight: simulate the real `notIn` filter recoverStuckDeploys
    // builds so the excluded id never even reaches the finalize step.
    mDeployFindMany.mockImplementation(async (args: any) => {
      const excluded: string[] = args.where.id?.notIn ?? [];
      const candidate = {
        id: "rollback-guard-1",
        appId: "app-a",
        createdAt: new Date(0),
        log: null,
        app: { name: "my-app" },
        server: { id: "srv-a", relayUrl: null, relayToken: null },
      };
      return excluded.includes(candidate.id) ? [] : [candidate];
    });

    await recoverStuckDeploys();

    expect(mDeployUpdateMany).not.toHaveBeenCalled();

    releaseRelay({ success: true, commitBefore: "a", commitAfter: "b" });
    await requestPromise;

    expect(activeDeployIds.has("rollback-guard-1")).toBe(false);
  });

  // Pins the actual hand-off HIGH-1 added: recoverBrokenDeploy polls health
  // for up to ~60s after this handler has already returned its HTTP
  // response, so the deploy id must stay in activeDeployIds for that whole
  // window, not just until the response settles. Two mutants would survive
  // without this test: making the route's `if (!recovering)
  // activeDeployIds.delete(deploy.id)` guard in the `finally` block
  // unconditional (it would then delete the id the moment the response
  // settles, regardless of recoverBrokenDeploy still running), or deleting
  // recoverBrokenDeploy's own self-registration entirely (covered
  // separately, in deploy-recovery.test.ts, with the real function).
  it("keeps the deploy id registered while recoverBrokenDeploy is still pending after a non-4xx error hand-off", async () => {
    mRelay.mockRejectedValueOnce(new Error("connect ECONNRESET"));

    let settleRecover!: () => void;
    const controlled = new Promise<void>((resolve) => {
      settleRecover = resolve;
    });
    mRecoverBrokenDeploy.mockReturnValue(controlled);

    const requestPromise = app().request("/servers/srv-a/apps/my-app/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    await requestPromise;
    expect(mRecoverBrokenDeploy).toHaveBeenCalledTimes(1);

    // The HTTP response has already settled, but recoverBrokenDeploy's own
    // hand-off promise has not: the id must still be registered. (The
    // mock here stands in for recoverBrokenDeploy's own add/delete
    // lifecycle, which is a separate concern pinned with the REAL function
    // in deploy-recovery.test.ts's "self-registration" tests.)
    expect(activeDeployIds.has("rollback-guard-1")).toBe(true);

    settleRecover();
    await controlled;
  });
});

// The route's `recoverBrokenDeploy(...)` call is fire-and-forget (see the
// comment above the call site in apps.ts): recoverBrokenDeploy's internal
// prisma calls already each carry a trailing .catch, but a throw before any
// of them (e.g. verifyDeployHealth itself rejecting) used to become an
// unhandled rejection with nothing chained here. Node >=20 treats an
// unhandled rejection as fatal by default and prod runs this as a single
// container under `restart: unless-stopped`, so this is a real crash risk,
// not just an ugly log line.
describe("POST /:name/rollback: recoverBrokenDeploy rejection is caught, not left unhandled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeDeployIds.clear();
    mAppUpsert.mockResolvedValue({ id: "app-a", name: "my-app" });
    mDeployCreate.mockResolvedValue({ id: "guard-1", status: "running" });
    mDeployUpdate.mockResolvedValue({});
  });

  it("logs and swallows a recoverBrokenDeploy rejection via its own .catch, instead of letting it propagate unhandled", async () => {
    mRelay.mockRejectedValueOnce(new Error("connect ECONNRESET"));

    let rejectRecover!: (err: Error) => void;
    const controlled = new Promise<void>((_resolve, reject) => {
      rejectRecover = reject;
    });
    mRecoverBrokenDeploy.mockReturnValue(controlled);

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await app().request("/servers/srv-a/apps/my-app/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(mRecoverBrokenDeploy).toHaveBeenCalledTimes(1);

    rejectRecover(new Error("verifyDeployHealth exploded"));
    // Give the .catch handler's microtask a turn to run. If the call site
    // has no .catch chained (the mutant this test exists to catch), this
    // rejection is left with no handler attached in this same synchronous
    // window, which is exactly what makes Node treat it as unhandled.
    await new Promise((r) => setTimeout(r, 0));

    const logged = consoleErrorSpy.mock.calls.some((args) =>
      String(args[0]).includes("[stuck-sweep] recoverBrokenDeploy failed"),
    );
    expect(logged).toBe(true);

    consoleErrorSpy.mockRestore();
  });
});
