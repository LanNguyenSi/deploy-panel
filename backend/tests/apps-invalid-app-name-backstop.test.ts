import { describe, expect, it, vi, beforeEach } from "vitest";

// Backstop for the typed refusal in findOrCreateApp (routes/apps.ts): every
// route that can reach it must answer 400 invalid_app_name, never a 500 from
// app.onError. Via HTTP the refusal is normally pre-empted by the route's own
// check (the local APP_NAME_PATTERN or relayAppPath's identical pattern), so
// the route-level case here mocks relay-path's relayAppPath to pass any name
// through (identity) — that is what simulates "a caller reached
// findOrCreateApp with an unvalidated name" and pins the route's mapping of
// the typed error. The direct findOrCreateApp case pins that the throw is the
// typed error at all (a bare Error would answer 500) and that no App row is
// written for a refused name.

vi.mock("../src/lib/ownership.js", () => ({
  getActorContext: vi.fn(() => ({ userId: "user-a", isAdmin: false })),
  findOwnedServer: vi.fn(async () => ({ id: "srv-a", userId: "user-a" })),
}));

vi.mock("../src/lib/relay-path.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/relay-path.js")>();
  return {
    ...actual,
    // Identity builder: same output as the real one for any valid name
    // (every accepted character survives encodeURIComponent unchanged),
    // but it refuses nothing, so the name reaches findOrCreateApp.
    relayAppPath: (name: string, suffix = "", query = "") =>
      `/api/apps/${String(name)}${suffix}${query}`,
  };
});

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    app: { upsert: vi.fn(), update: vi.fn().mockResolvedValue({}), findUnique: vi.fn().mockResolvedValue({ liveUrl: null }) },
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

vi.mock("../src/lib/stream-deploy.js", () => ({ streamDeploy: vi.fn() }));
vi.mock("../src/lib/deploy-recovery.js", () => ({
  recoverBrokenDeploy: vi.fn().mockResolvedValue(undefined),
  registerActiveDeploy: vi.fn(),
  releaseActiveDeploy: vi.fn(),
}));

import { prisma } from "../src/lib/prisma.js";
import { appsRouter, findOrCreateApp, InvalidAppNameForWriteError } from "../src/routes/apps.js";
import { Hono } from "hono";

const mAppUpsert = prisma.app.upsert as unknown as ReturnType<typeof vi.fn>;
const mDeployCreate = prisma.deploy.create as unknown as ReturnType<typeof vi.fn>;

function app() {
  const a = new Hono();
  a.route("/servers/:serverId/apps", appsRouter as unknown as Hono);
  return a;
}

describe("findOrCreateApp: refused names throw the typed error, no row is written", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mAppUpsert.mockResolvedValue({ id: "app-a", name: "my-app" });
  });

  it.each(["my.app", "..", "a/b", ""])("findOrCreateApp(%j) rejects with InvalidAppNameForWriteError and never reaches the upsert", async (name) => {
    await expect(findOrCreateApp("srv-a", name)).rejects.toBeInstanceOf(InvalidAppNameForWriteError);
    expect(mAppUpsert).not.toHaveBeenCalled();
  });

  it("a valid name upserts as before", async () => {
    await expect(findOrCreateApp("srv-a", "my-app")).resolves.toEqual({ id: "app-a", name: "my-app" });
    expect(mAppUpsert).toHaveBeenCalledOnce();
  });
});

describe("rollback route: an unvalidated name reaching findOrCreateApp answers 400, not 500", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mAppUpsert.mockResolvedValue({ id: "app-a", name: "my-app" });
    mDeployCreate.mockResolvedValue({ id: "deploy-1", status: "running" });
  });

  // relayAppPath is identity-mocked (see the top of the file), so the name
  // gets past the route's relay-path guard and findOrCreateApp's own pattern
  // is what refuses it — the situation the typed-error mapping exists for.
  it("POST /:name/rollback with a dotted name: 400 invalid_app_name, no Deploy row", async () => {
    const res = await app().request("/servers/srv-a/apps/my.app/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_app_name");
    expect(mAppUpsert).not.toHaveBeenCalled();
    expect(mDeployCreate).not.toHaveBeenCalled();
  });
});
