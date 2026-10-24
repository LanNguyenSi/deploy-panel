import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn(),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

import { prisma } from "../src/lib/prisma.js";
import { serversRouter } from "../src/routes/servers.js";
import { activeInstalls } from "../src/services/active-installs.js";
import {
  computeRelayOutdated,
  GHCR_BLOB_URL_PREFIX,
  GHCR_MANIFEST_BY_DIGEST_PREFIX,
  GHCR_MANIFEST_URL,
  GHCR_TOKEN_URL,
  getLatestRelayRevision,
  normalizeRevision,
  resetGhcrCache,
} from "../src/lib/ghcr.js";

const mServer = prisma.server as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mAudit = prisma.auditLog as unknown as {
  create: ReturnType<typeof vi.fn>;
};

type ActorVars = {
  Variables: { userId?: string; isAdmin?: boolean; authType?: string };
};

function appFor(actor: { userId: string | null; isAdmin: boolean }) {
  const app = new Hono<ActorVars>();
  app.use("/*", async (c, next) => {
    if (actor.userId) c.set("userId", actor.userId);
    c.set("isAdmin", actor.isAdmin);
    await next();
  });
  app.route("/servers", serversRouter as unknown as Hono<ActorVars>);
  return app;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const OLD_SHA = "89b3f8b920be3ae58617395fddb4d73fe5138f72";
const NEW_SHA = "6b2c7bb27d0db0f37b7abb9e3e8286cf44baa4a6";

const OWNED_SERVER = {
  id: "srv-1",
  userId: "user-a",
  name: "prod-vps",
  host: "203.0.113.10",
  status: "online",
  relayUrl: "https://relay.example.com",
  relayToken: "secret-relay-token",
  sshKeyPath: null,
  hostKeySha256: null,
  relayMode: "greenfield",
  relayDir: "/opt/agent-relay",
  relayComposeFile: null,
  lastSeenAt: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
};

describe("normalizeRevision and computeRelayOutdated", () => {
  it("normalizes 7-40 hex commit SHAs and rejects missing, 'unknown', or non-hex values", () => {
    expect(normalizeRevision(OLD_SHA)).toBe(OLD_SHA);
    expect(normalizeRevision(`  ${OLD_SHA.toUpperCase()} \n`)).toBe(OLD_SHA);
    expect(normalizeRevision("89b3f8b")).toBe("89b3f8b");
    expect(normalizeRevision("unknown")).toBeNull();
    expect(normalizeRevision("UNKNOWN")).toBeNull();
    expect(normalizeRevision("")).toBeNull();
    expect(normalizeRevision("   ")).toBeNull();
    expect(normalizeRevision("not-a-sha")).toBeNull();
    expect(normalizeRevision(null)).toBeNull();
    expect(normalizeRevision(undefined)).toBeNull();
  });

  it("returns false when revisions match, true when different, and null when either is unknown/missing", () => {
    expect(computeRelayOutdated(NEW_SHA, NEW_SHA)).toBe(false);
    expect(computeRelayOutdated(OLD_SHA, NEW_SHA)).toBe(true);
    expect(computeRelayOutdated("unknown", NEW_SHA)).toBeNull();
    expect(computeRelayOutdated(null, NEW_SHA)).toBeNull();
    expect(computeRelayOutdated(OLD_SHA, null)).toBeNull();
    expect(computeRelayOutdated(OLD_SHA, "unknown")).toBeNull();
    expect(computeRelayOutdated(null, null)).toBeNull();
  });
});

describe("getLatestRelayRevision (GHCR anonymous lookup + TTL cache + fail-soft)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetGhcrCache();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetGhcrCache();
  });

  it("resolves revision from GHCR token + manifest + config blob and caches within TTL", async () => {
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url === GHCR_TOKEN_URL) {
        return jsonRes({ token: "anon-ghcr-token" });
      }
      if (url === GHCR_MANIFEST_URL) {
        return jsonRes({
          schemaVersion: 2,
          config: { digest: "sha256:cfg123" },
        });
      }
      if (url === `${GHCR_BLOB_URL_PREFIX}sha256:cfg123`) {
        return jsonRes({
          config: {
            Labels: {
              "org.opencontainers.image.revision": NEW_SHA,
            },
          },
        });
      }
      return jsonRes({ error: "unexpected url" }, 404);
    });

    const first = await getLatestRelayRevision();
    expect(first).toBe(NEW_SHA);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Second call uses in-memory cache without hitting network
    const second = await getLatestRelayRevision();
    expect(second).toBe(NEW_SHA);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("resolves revision across an OCI index / manifest list", async () => {
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url === GHCR_TOKEN_URL) return jsonRes({ token: "anon-token" });
      if (url === GHCR_MANIFEST_URL) {
        return jsonRes({
          manifests: [
            {
              digest: "sha256:amd64manifest",
              platform: { architecture: "amd64", os: "linux" },
            },
          ],
        });
      }
      if (url === `${GHCR_MANIFEST_BY_DIGEST_PREFIX}sha256:amd64manifest`) {
        return jsonRes({
          config: { digest: "sha256:cfg-amd64" },
        });
      }
      if (url === `${GHCR_BLOB_URL_PREFIX}sha256:cfg-amd64`) {
        return jsonRes({
          config: {
            Labels: { "org.opencontainers.image.revision": NEW_SHA },
          },
        });
      }
      return jsonRes({}, 404);
    });

    expect(await getLatestRelayRevision()).toBe(NEW_SHA);
  });

  it("fails soft to null when GHCR token or manifest is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    expect(await getLatestRelayRevision()).toBeNull();

    fetchMock.mockResolvedValueOnce(jsonRes({ token: "anon-token" }));
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "denied" }, 503));
    expect(await getLatestRelayRevision()).toBeNull();
  });
});

describe("GET /servers/:id/relay-status and POST /servers/:id/test", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    activeInstalls.clear();
    resetGhcrCache();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetGhcrCache();
  });

  function mockGhcrLatest(sha: string | null) {
    if (!sha) {
      fetchMock.mockImplementation(async (input: string | URL) => {
        const url = String(input);
        if (url.startsWith("https://ghcr.io/")) {
          return jsonRes({ error: "unavailable" }, 503);
        }
        throw new Error(`unhandled url ${url}`);
      });
      return;
    }
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url === GHCR_TOKEN_URL) return jsonRes({ token: "anon" });
      if (url === GHCR_MANIFEST_URL) {
        return jsonRes({
          annotations: { "org.opencontainers.image.revision": sha },
        });
      }
      throw new Error(`unhandled url ${url}`);
    });
  }

  it("enforces server ownership on GET /servers/:id/relay-status (404 for another user's server)", async () => {
    mServer.findUnique.mockResolvedValue({ ...OWNED_SERVER, userId: "user-b" });
    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/srv-1/relay-status",
    );
    expect(res.status).toBe(404);
  });

  it("reports relayOutdated: false and state: 'current' when relay /health matches GHCR :latest", async () => {
    mServer.findUnique.mockResolvedValue(OWNED_SERVER);
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url === "https://relay.example.com/health") {
        return jsonRes({ status: "ok", version: "0.6.0", revision: NEW_SHA });
      }
      if (url === GHCR_TOKEN_URL) return jsonRes({ token: "anon" });
      if (url === GHCR_MANIFEST_URL) {
        return jsonRes({
          annotations: { "org.opencontainers.image.revision": NEW_SHA },
        });
      }
      return jsonRes({}, 404);
    });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/srv-1/relay-status",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      relayRevision: NEW_SHA,
      latestRevision: NEW_SHA,
      relayOutdated: false,
      state: "current",
    });
  });

  it("reports relayOutdated: true and state: 'outdated' when relay /health differs from GHCR :latest", async () => {
    mServer.findUnique.mockResolvedValue(OWNED_SERVER);
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url === "https://relay.example.com/health") {
        return jsonRes({ status: "ok", version: "0.6.0", revision: OLD_SHA });
      }
      if (url === GHCR_TOKEN_URL) return jsonRes({ token: "anon" });
      if (url === GHCR_MANIFEST_URL) {
        return jsonRes({
          annotations: { "org.opencontainers.image.revision": NEW_SHA },
        });
      }
      return jsonRes({}, 404);
    });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/srv-1/relay-status",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      relayRevision: OLD_SHA,
      latestRevision: NEW_SHA,
      relayOutdated: true,
      state: "outdated",
    });

    // POST /servers/:id/test also exposes relayRevision, latestRevision, relayOutdated
    const testRes = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/srv-1/test",
      { method: "POST" },
    );
    expect(testRes.status).toBe(200);
    expect(await testRes.json()).toMatchObject({
      status: "online",
      relayRevision: OLD_SHA,
      latestRevision: NEW_SHA,
      relayOutdated: true,
    });
  });

  it("reports relayOutdated: null and state: 'unknown' when relay is unreachable or reports revision 'unknown'", async () => {
    mServer.findUnique.mockResolvedValue(OWNED_SERVER);
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url === "https://relay.example.com/health") {
        return jsonRes({ status: "ok", version: "0.6.0", revision: "unknown" });
      }
      if (url === GHCR_TOKEN_URL) return jsonRes({ token: "anon" });
      if (url === GHCR_MANIFEST_URL) {
        return jsonRes({
          annotations: { "org.opencontainers.image.revision": NEW_SHA },
        });
      }
      return jsonRes({}, 404);
    });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/srv-1/relay-status",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      relayRevision: null,
      latestRevision: NEW_SHA,
      relayOutdated: null,
      state: "unknown",
    });
  });

  it("reports relayOutdated: null and state: 'unknown' when GHCR is unreachable", async () => {
    mServer.findUnique.mockResolvedValue(OWNED_SERVER);
    mockGhcrLatest(null);
    fetchMock.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url === "https://relay.example.com/health") {
        return jsonRes({ status: "ok", version: "0.6.0", revision: OLD_SHA });
      }
      return jsonRes({ error: "ghcr down" }, 503);
    });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/srv-1/relay-status",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      relayRevision: OLD_SHA,
      latestRevision: null,
      relayOutdated: null,
      state: "unknown",
    });
  });
});

describe("POST /servers/:id/relay-self-update", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    activeInstalls.clear();
    resetGhcrCache();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    activeInstalls.clear();
    resetGhcrCache();
  });

  it("returns 404 when server is owned by another user", async () => {
    mServer.findUnique.mockResolvedValue({ ...OWNED_SERVER, userId: "user-b" });
    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/srv-1/relay-self-update",
      { method: "POST" },
    );
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 429 when an install, update-image, or self-update is already in progress on the server", async () => {
    mServer.findUnique.mockResolvedValue(OWNED_SERVER);
    for (const lockKey of ["update-image:srv-1", "self-update:srv-1"]) {
      activeInstalls.clear();
      activeInstalls.add(lockKey);

      const res = await appFor({ userId: "user-a", isAdmin: false }).request(
        "/servers/srv-1/relay-self-update",
        { method: "POST" },
      );
      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({ error: "rate_limited" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes through 409 when the relay refuses self-update because a deploy or self-update is active", async () => {
    mServer.findUnique.mockResolvedValue(OWNED_SERVER);
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://relay.example.com/health") {
        return jsonRes({ status: "ok", version: "0.6.0", revision: OLD_SHA });
      }
      if (url === "https://relay.example.com/api/self-update" && init?.method === "POST") {
        return jsonRes(
          { error: "Deploy or self-update already in progress" },
          409,
        );
      }
      return jsonRes({}, 404);
    });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/srv-1/relay-self-update",
      { method: "POST" },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "conflict",
      kind: "relay_busy",
      message: "Deploy or self-update already in progress",
    });
    expect(activeInstalls.has("self-update:srv-1")).toBe(false);
    expect(mAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "server.relay-self-update.failed",
          detail: "relay_busy",
        }),
      }),
    );
  });

  it("returns 422 when the relay refuses self-update due to a build-based compose file", async () => {
    mServer.findUnique.mockResolvedValue(OWNED_SERVER);
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://relay.example.com/health") {
        return jsonRes({ status: "ok", version: "0.6.0", revision: OLD_SHA });
      }
      if (url === "https://relay.example.com/api/self-update" && init?.method === "POST") {
        return jsonRes(
          {
            kind: "compose_is_build_based",
            message: "Relay compose uses build:; self-update requires image-based compose.",
          },
          422,
        );
      }
      return jsonRes({}, 404);
    });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/srv-1/relay-self-update",
      { method: "POST" },
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: "self_update_refused",
      kind: "compose_is_build_based",
    });
  });

  it("triggers POST /api/self-update, polls /health until the new revision answers, updates Server.status via action source, and audits success", async () => {
    mServer.findUnique.mockResolvedValue(OWNED_SERVER);
    let healthCalls = 0;

    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://relay.example.com/health") {
        healthCalls += 1;
        // Call 1: pre-trigger probe (OLD_SHA)
        // Call 2: first post-trigger poll while container is restarting (502)
        // Call 3: container back online with NEW_SHA
        if (healthCalls === 1) {
          return jsonRes({ status: "ok", version: "0.6.0", revision: OLD_SHA });
        }
        if (healthCalls === 2) {
          return new Response("restarting", { status: 502 });
        }
        return jsonRes({ status: "ok", version: "0.6.0", revision: NEW_SHA });
      }
      if (url === "https://relay.example.com/api/self-update" && init?.method === "POST") {
        expect((init.headers as Record<string, string>)["Authorization"]).toBe(
          "Bearer secret-relay-token",
        );
        return jsonRes(
          {
            status: "updating",
            previousRevision: OLD_SHA,
            targetRevision: NEW_SHA,
          },
          202,
        );
      }
      if (url === GHCR_TOKEN_URL) return jsonRes({ token: "anon" });
      if (url === GHCR_MANIFEST_URL) {
        return jsonRes({
          annotations: { "org.opencontainers.image.revision": NEW_SHA },
        });
      }
      return jsonRes({}, 404);
    });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/srv-1/relay-self-update",
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "online",
      previousRevision: OLD_SHA,
      relayRevision: NEW_SHA,
      latestRevision: NEW_SHA,
      relayOutdated: false,
    });
    expect(activeInstalls.has("self-update:srv-1")).toBe(false);
    expect(mServer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "srv-1" },
        data: expect.objectContaining({ status: "online" }),
      }),
    );
    expect(mAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "server.relay-self-update.success",
          actorUserId: "user-a",
        }),
      }),
    );
  });

  it("returns 502 health_timeout and sets Server.status to offline when the relay does not recover after self-update", async () => {
    mServer.findUnique.mockResolvedValue(OWNED_SERVER);
    let healthCalls = 0;

    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://relay.example.com/health") {
        healthCalls += 1;
        if (healthCalls === 1) {
          return jsonRes({ status: "ok", version: "0.6.0", revision: OLD_SHA });
        }
        return new Response("down", { status: 502 });
      }
      if (url === "https://relay.example.com/api/self-update" && init?.method === "POST") {
        return jsonRes({ status: "updating", targetRevision: NEW_SHA }, 202);
      }
      if (url === GHCR_TOKEN_URL) return jsonRes({ token: "anon" });
      if (url === GHCR_MANIFEST_URL) {
        return jsonRes({
          annotations: { "org.opencontainers.image.revision": NEW_SHA },
        });
      }
      return jsonRes({}, 404);
    });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/srv-1/relay-self-update",
      { method: "POST" },
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: "self_update_failed",
      kind: "health_timeout",
      relayRevision: null,
      latestRevision: NEW_SHA,
      relayOutdated: null,
    });
    expect(mServer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "srv-1" },
        data: expect.objectContaining({ status: "offline" }),
      }),
    );
    expect(activeInstalls.has("self-update:srv-1")).toBe(false);
  });

  function relayAnswering(trigger: () => Promise<Response>) {
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://relay.example.com/health") {
        return jsonRes({ status: "ok", version: "0.6.0", revision: OLD_SHA });
      }
      if (url === "https://relay.example.com/api/self-update" && init?.method === "POST") {
        return trigger();
      }
      return jsonRes({}, 404);
    });
  }

  function expectNoStatusChange() {
    expect(mServer.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: expect.anything() }) }),
    );
  }

  for (const status of [404, 405]) {
    it(`returns 422 self_update_unsupported without touching Server.status when the relay answers ${status} (relay image without self-update)`, async () => {
      mServer.findUnique.mockResolvedValue(OWNED_SERVER);
      relayAnswering(async () =>
        new Response("404 Not Found", { status, headers: { "content-type": "text/plain" } }),
      );

      const res = await appFor({ userId: "user-a", isAdmin: false }).request(
        "/servers/srv-1/relay-self-update",
        { method: "POST" },
      );
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({
        error: "self_update_refused",
        kind: "self_update_unsupported",
        message: expect.stringContaining("Update via SSH (fallback)"),
      });
      expectNoStatusChange();
      expect(mAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "server.relay-self-update.failed",
            detail: "self_update_unsupported",
          }),
        }),
      );
      expect(activeInstalls.has("self-update:srv-1")).toBe(false);
    });
  }

  for (const status of [404, 502]) {
    it(`returns 502 relay_down and sets Server.status to offline when /health and the trigger both fail with ${status} (stopped relay behind Traefik)`, async () => {
      mServer.findUnique.mockResolvedValue(OWNED_SERVER);
      fetchMock.mockImplementation(async () =>
        new Response("404 page not found", { status, headers: { "content-type": "text/plain" } }),
      );

      const res = await appFor({ userId: "user-a", isAdmin: false }).request(
        "/servers/srv-1/relay-self-update",
        { method: "POST" },
      );
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ error: "self_update_failed", kind: "relay_down" });
      expect(mServer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "srv-1" },
          data: expect.objectContaining({ status: "offline" }),
        }),
      );
      expect(activeInstalls.has("self-update:srv-1")).toBe(false);
    });
  }

  it("returns 502 without touching Server.status when the relay answers with a server error", async () => {
    mServer.findUnique.mockResolvedValue(OWNED_SERVER);
    relayAnswering(async () => jsonRes({ error: "Failed to pull image" }, 502));

    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/srv-1/relay-self-update",
      { method: "POST" },
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      kind: "http_502",
      message: "Failed to pull image",
    });
    expectNoStatusChange();
  });

  it("returns 504 trigger_timeout without touching Server.status when the trigger times out", async () => {
    mServer.findUnique.mockResolvedValue(OWNED_SERVER);
    relayAnswering(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/srv-1/relay-self-update",
      { method: "POST" },
    );
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ kind: "trigger_timeout" });
    expectNoStatusChange();
    expect(activeInstalls.has("self-update:srv-1")).toBe(false);
  });

  it("returns 502 trigger_unreachable and sets Server.status to offline when the relay cannot be reached", async () => {
    mServer.findUnique.mockResolvedValue(OWNED_SERVER);
    relayAnswering(async () => {
      throw new TypeError("fetch failed");
    });

    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/srv-1/relay-self-update",
      { method: "POST" },
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ kind: "trigger_unreachable" });
    expect(mServer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "srv-1" },
        data: expect.objectContaining({ status: "offline" }),
      }),
    );
  });
});
