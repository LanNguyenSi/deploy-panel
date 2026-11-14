import { describe, expect, it, vi, beforeEach } from "vitest";

// POST /api/servers/:serverId/sync upserts one App row per configured relay
// app. A relay that REPORTS an app under a name the panel's relay path guard
// (lib/relay-path.ts, RELAY_APP_NAME_PATTERN) refuses, `../x`, must be
// skipped: no relay app-detail call for it, no App row written for it, and
// the pass continues for the remaining apps. If the skip were removed, the
// InvalidAppNameError would hit the route's outer catch (classifyProbeError
// maps it to nothing) and the whole sync would answer 500; if the helper were
// a raw template, `../x` would be interpolated into the detail URL.

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    app: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("../src/lib/relay.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/relay.js")>("../src/lib/relay.js");
  return { ...actual, relayRequest: vi.fn() };
});

vi.mock("../src/lib/ownership.js", () => ({
  getActorContext: vi.fn(() => ({ userId: "user-a", isAdmin: true })),
  findOwnedServer: vi.fn(async () => ({ id: "srv-a", relayUrl: "http://relay.example" })),
}));

vi.mock("../src/lib/target-guard.js", () => ({
  denyPrivateServerTargets: vi.fn(async () => null),
}));

vi.mock("../src/services/server-status.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/server-status.js")>("../src/services/server-status.js");
  return { ...actual, setServerStatus: vi.fn().mockResolvedValue(true) };
});

import { prisma } from "../src/lib/prisma.js";
import { relayRequest } from "../src/lib/relay.js";
import { setServerStatus } from "../src/services/server-status.js";
import { syncRouter } from "../src/routes/sync.js";
import { Hono } from "hono";

const mRelay = relayRequest as unknown as ReturnType<typeof vi.fn>;
const mAppCreate = prisma.app.create as unknown as ReturnType<typeof vi.fn>;
const mSetStatus = setServerStatus as unknown as ReturnType<typeof vi.fn>;

function app() {
  const a = new Hono();
  a.route("/servers", syncRouter as unknown as Hono);
  return a;
}

describe("POST /servers/:serverId/sync skips relay apps the path guard refuses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mRelay.mockImplementation(async ({ path }: { path: string }) =>
      path === "/api/apps"
        ? { apps: [{ name: "../x", configured: true }, { name: "ok", configured: true }] }
        : { app: { containers: "up" } },
    );
  });

  it("skips ../x (no detail call, no App write) and still syncs ok", async () => {
    const res = await app().request("/servers/srv-a/sync", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ synced: true, apps: 2, created: 1, updated: 0 });

    // Listing + the `ok` detail only: the refused name never reached the relay.
    expect(mRelay).toHaveBeenCalledTimes(2);
    expect(mRelay.mock.calls.map((c) => c[0].path)).toEqual(["/api/apps", "/api/apps/ok"]);
    expect(mRelay.mock.calls.every((c) => !String(c[0].path).includes(".."))).toBe(true);

    // One App row, for `ok` (healthy from the containers answer); none for the
    // skipped name.
    expect(mAppCreate).toHaveBeenCalledTimes(1);
    expect(mAppCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "ok", status: "healthy" }) }),
    );
    expect(mSetStatus).toHaveBeenCalledWith(expect.objectContaining({ serverId: "srv-a", status: "online" }));
  });

  it("a clean relay app list is unaffected", async () => {
    mRelay.mockImplementation(async ({ path }: { path: string }) =>
      path === "/api/apps" ? { apps: [{ name: "_bad", configured: true }] } : { app: { containers: null } },
    );
    const res = await app().request("/servers/srv-a/sync", { method: "POST" });
    // The relay accepts `_bad`, so sync operates on it (unhealthy: no running
    // containers reported), exactly as at the base.
    expect(res.status).toBe(200);
    expect(mRelay.mock.calls.map((c) => c[0].path)).toEqual(["/api/apps", "/api/apps/_bad"]);
    expect(mAppCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "_bad", status: "unhealthy" }) }),
    );
  });
});
