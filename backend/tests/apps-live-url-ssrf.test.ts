import { describe, expect, it, vi, beforeEach } from "vitest";

// PATCH /:name/live-url persists an operator-set public URL that the
// post-deploy gate later fetches server-side. These tests pin the write-time
// SSRF guard: an internal/loopback host must 400 BEFORE any DB write, a public
// host must persist, and an empty value must still clear the field.

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
    app: { update: vi.fn(async () => ({ id: "a1", liveUrl: null })) },
  },
}));

vi.mock("../src/lib/audit.js", () => ({
  audit: vi.fn(),
  getActor: vi.fn(() => "panel"),
  getActorUserId: vi.fn(() => "user-a"),
}));

vi.mock("../src/lib/stream-deploy.js", () => ({ streamDeploy: vi.fn() }));
vi.mock("../src/lib/deploy-recovery.js", () => ({ recoverBrokenDeploy: vi.fn() }));

import { prisma } from "../src/lib/prisma.js";
import { appsRouter } from "../src/routes/apps.js";
import { Hono } from "hono";

const mUpdate = (prisma.app as any).update as ReturnType<typeof vi.fn>;

function app() {
  const a = new Hono();
  a.route("/servers/:serverId/apps", appsRouter as unknown as Hono);
  return a;
}

function patchLiveUrl(name: string, liveUrl: string) {
  return app().request(`/servers/srv-a/apps/${name}/live-url`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ liveUrl }),
  });
}

describe("PATCH /live-url SSRF write guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists a public URL", async () => {
    const res = await patchLiveUrl("thd", "https://status.opentriologue.ai/");
    expect(res.status).toBe(200);
    expect(mUpdate).toHaveBeenCalledTimes(1);
    expect(mUpdate.mock.calls[0][0].data.liveUrl).toBe("https://status.opentriologue.ai/");
  });

  it.each([
    ["loopback literal", "http://127.0.0.1:9000/"],
    ["link-local metadata", "http://169.254.169.254/latest/meta-data/"],
    ["RFC1918", "http://10.1.2.3/"],
    ["localhost", "http://localhost:8080/"],
    ["bracketed IPv6 loopback", "http://[::1]/"],
  ])("rejects an internal host (%s) with 400 and no DB write", async (_label, url) => {
    const res = await patchLiveUrl("thd", url);
    expect(res.status).toBe(400);
    expect(mUpdate).not.toHaveBeenCalled();
  });

  it("still clears the field when given an empty value", async () => {
    const res = await patchLiveUrl("thd", "");
    expect(res.status).toBe(200);
    expect(mUpdate).toHaveBeenCalledTimes(1);
    expect(mUpdate.mock.calls[0][0].data.liveUrl).toBeNull();
  });
});
