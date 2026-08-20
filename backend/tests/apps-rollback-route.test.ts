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
    app: { upsert: vi.fn() },
    deploy: { create: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("../src/lib/audit.js", () => ({
  audit: vi.fn(),
  getActor: vi.fn(() => "panel"),
  getActorUserId: vi.fn(() => "user-a"),
}));

vi.mock("../src/lib/deploy-recovery.js", () => ({ recoverBrokenDeploy: vi.fn() }));
vi.mock("../src/lib/stream-deploy.js", () => ({ streamDeploy: vi.fn() }));

import { relayRequest, RelayError } from "../src/lib/relay.js";
import { prisma } from "../src/lib/prisma.js";
import { appsRouter } from "../src/routes/apps.js";
import { recoverBrokenDeploy } from "../src/lib/deploy-recovery.js";
import { Hono } from "hono";

const mRelay = relayRequest as unknown as ReturnType<typeof vi.fn>;
const mAppUpsert = prisma.app.upsert as unknown as ReturnType<typeof vi.fn>;
const mDeployCreate = prisma.deploy.create as unknown as ReturnType<typeof vi.fn>;
const mDeployUpdate = prisma.deploy.update as unknown as ReturnType<typeof vi.fn>;
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
