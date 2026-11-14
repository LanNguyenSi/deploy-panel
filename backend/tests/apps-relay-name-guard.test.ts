import { describe, expect, it, vi, beforeEach } from "vitest";

// The :name routes of routes/apps.ts build their relay path through
// relayAppPath (lib/relay-path.ts). Two properties are pinned here for GET
// /logs, GET /preflight, GET /env and PUT /env:
//
//   1. A name the helper refuses (dots, traversal: what the relay refuses)
//      answers 400 invalid_app_name with NO relay round-trip and no App row.
//   2. Each site builds its path BY CALLING the helper (spy assertion) and
//      maps a helper refusal (InvalidAppNameError) to its usual 400 instead
//      of an unhandled throw, so replacing the helper with a raw template,
//      or deleting the InvalidAppNameError catch, fails a test even though
//      the route's own pattern already screens such names at the boundary.

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

vi.mock("../src/lib/relay-path.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/relay-path.js")>("../src/lib/relay-path.js");
  return { ...actual, relayAppPath: vi.fn((name: string, suffix = "", query = "") => actual.relayAppPath(name, suffix, query)) };
});

vi.mock("../src/lib/ownership.js", () => ({
  getActorContext: vi.fn(() => ({ userId: "user-a", isAdmin: false })),
  findOwnedServer: vi.fn(async () => ({ id: "srv-a", userId: "user-a" })),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    app: { findMany: vi.fn(), upsert: vi.fn(), findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() },
    deploy: { create: vi.fn(), findFirst: vi.fn() },
    server: { findUnique: vi.fn() },
    envVarChange: { createMany: vi.fn().mockResolvedValue({ count: 0 }), findMany: vi.fn() },
  },
}));

vi.mock("../src/lib/audit.js", () => ({
  audit: vi.fn(),
  getActor: vi.fn(() => "panel"),
  getActorUserId: vi.fn(() => "user-a"),
}));

vi.mock("../src/lib/stream-deploy.js", () => ({ streamDeploy: vi.fn() }));
vi.mock("../src/lib/deploy-recovery.js", () => ({ recoverBrokenDeploy: vi.fn() }));

import { relayRequest } from "../src/lib/relay.js";
import { relayAppPath, InvalidAppNameError } from "../src/lib/relay-path.js";
import { prisma } from "../src/lib/prisma.js";
import { appsRouter } from "../src/routes/apps.js";
import { Hono } from "hono";

const mRelay = relayRequest as unknown as ReturnType<typeof vi.fn>;
const mPath = relayAppPath as unknown as ReturnType<typeof vi.fn>;
const mAppUpsert = prisma.app.upsert as unknown as ReturnType<typeof vi.fn>;

function app() {
  const a = new Hono();
  a.route("/servers/:serverId/apps", appsRouter as unknown as Hono);
  return a;
}

// Names the helper refuses (dots/traversal) but the router still matches as
// one :name segment (dots are safe in a URL segment; traversal arrives
// percent-encoded, like the rollback route's existing cases).
const REFUSED = ["a.b", "%2e%2e%2fx", "a%20b"];

const SITES: Array<{ label: string; route: (name: string) => string; init?: { method: string; body?: string }; suffix: string; query?: string }> = [
  { label: "GET /:name/logs", route: (n) => `/servers/srv-a/apps/${n}/logs`, suffix: "/logs", query: "?lines=50" },
  { label: "GET /:name/preflight", route: (n) => `/servers/srv-a/apps/${n}/preflight`, suffix: "/preflight" },
  { label: "GET /:name/env", route: (n) => `/servers/srv-a/apps/${n}/env`, suffix: "/env" },
  {
    label: "PUT /:name/env",
    route: (n) => `/servers/srv-a/apps/${n}/env`,
    init: { method: "PUT", body: JSON.stringify({ entries: [{ key: "K", value: "v" }] }) },
    suffix: "/env",
  },
];

describe("apps :name routes build relay paths through relayAppPath and map its refusal to 400", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mAppUpsert.mockResolvedValue({ id: "app-a", name: "ok" });
  });

  // 1. A refused name: 400 invalid_app_name, no relay call, no App write.
  describe.each(SITES)("$label", (site) => {
    it.each(REFUSED)("answers 400 invalid_app_name without a relay call for %j", async (encoded) => {
      const res = await app().request(site.route(encoded), site.init as RequestInit);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_app_name" });
      expect(mRelay).not.toHaveBeenCalled();
      if (site.init?.method === "PUT") expect(mAppUpsert).not.toHaveBeenCalled();
    });

    it("builds the path by calling the helper for a clean name", async () => {
      // Success shape per site: the relay answers a minimal valid payload.
      mRelay.mockImplementation(async ({ method }: { method?: string }) =>
        method === "PUT" ? {} : { entries: [], passed: true, logs: [] },
      );
      const res = await app().request(site.route("ok"), site.init as RequestInit);
      expect(res.status).toBe(200);
      // Exact arity as the route calls it (logs passes a query, the rest don't).
      expect(mPath).toHaveBeenCalledWith("ok", site.suffix, ...(site.query !== undefined ? [site.query] : []));
      expect(mRelay).toHaveBeenCalled();
      expect(mRelay.mock.calls[0][0].path).toBe(`/api/apps/ok${site.suffix}${site.query ?? ""}`);
    });

    it("answers 400 invalid_app_name (not 500) when the helper throws, with no relay call", async () => {
      // The backstop: the route-level pattern admits "ok", the helper is the
      // one that refuses. Deleting the InvalidAppNameError catch here turns
      // this into an unhandled throw (500), failing the test.
      mPath.mockImplementationOnce(() => {
        throw new InvalidAppNameError("ok");
      });
      const res = await app().request(site.route("ok"), site.init as RequestInit);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_app_name" });
      expect(mRelay).not.toHaveBeenCalled();
      if (site.init?.method === "PUT") expect(mAppUpsert).not.toHaveBeenCalled();
    });
  });
});
