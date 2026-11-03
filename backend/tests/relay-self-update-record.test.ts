// The relay pulls the image before it answers 202 and compose can outlast
// the panel's /health poll window, so the panel reads the relay's own
// GET /api/self-update record when /health did not settle the update.
// Precedence: a /health revision matching the target wins and the record is
// never read; otherwise the record decides; no usable record keeps the
// panel's own result.
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
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

import { prisma } from "../src/lib/prisma.js";
import { serversRouter } from "../src/routes/servers.js";
import { activeInstalls } from "../src/services/active-installs.js";
import {
  GHCR_MANIFEST_URL,
  GHCR_TOKEN_URL,
  resetGhcrCache,
} from "../src/lib/ghcr.js";

const mServer = prisma.server as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mAudit = prisma.auditLog as unknown as { create: ReturnType<typeof vi.fn> };

type ActorVars = { Variables: { userId?: string; isAdmin?: boolean; authType?: string } };

function appFor() {
  const app = new Hono<ActorVars>();
  app.use("/*", async (c, next) => {
    c.set("userId", "user-a");
    c.set("isAdmin", false);
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
const OTHER_SHA = "1111111111111111111111111111111111111111";
const RELAY = "https://relay.example.com";

const OWNED_SERVER = {
  id: "srv-1",
  userId: "user-a",
  name: "prod-vps",
  host: "203.0.113.10",
  status: "online",
  relayUrl: RELAY,
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

type RecordResponder = () => Response | Promise<Response>;

describe("POST /servers/:id/relay-self-update reads the relay's own record", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let recordCalls: Array<RequestInit | undefined>;

  beforeEach(() => {
    vi.clearAllMocks();
    activeInstalls.clear();
    resetGhcrCache();
    recordCalls = [];
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mServer.findUnique.mockResolvedValue(OWNED_SERVER);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    activeInstalls.clear();
    resetGhcrCache();
  });

  /**
   * @param healthAfter revision /health reports after the trigger
   * @param trigger how POST /api/self-update behaves
   * @param record how GET /api/self-update behaves
   */
  function relay(opts: {
    healthAfter: string;
    trigger?: RecordResponder;
    record: RecordResponder;
  }) {
    let healthCalls = 0;
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${RELAY}/health`) {
        healthCalls += 1;
        return jsonRes({
          status: "ok",
          version: "0.6.0",
          revision: healthCalls === 1 ? OLD_SHA : opts.healthAfter,
        });
      }
      if (url === `${RELAY}/api/self-update` && init?.method === "POST") {
        return (
          opts.trigger?.() ??
          jsonRes({ status: "accepted", previousRevision: OLD_SHA, targetRevision: NEW_SHA }, 202)
        );
      }
      if (url === `${RELAY}/api/self-update`) {
        recordCalls.push(init);
        return opts.record();
      }
      if (url === GHCR_TOKEN_URL) return jsonRes({ token: "anon" });
      if (url === GHCR_MANIFEST_URL) {
        return jsonRes({ annotations: { "org.opencontainers.image.revision": NEW_SHA } });
      }
      return jsonRes({}, 404);
    });
  }

  const state = (over: Record<string, unknown>) => ({
    tag: "latest",
    previousRevision: OLD_SHA,
    targetRevision: NEW_SHA,
    ...over,
  });

  async function selfUpdate() {
    const res = await appFor().request("/servers/srv-1/relay-self-update", { method: "POST" });
    return { res, body: (await res.json()) as Record<string, unknown> };
  }

  function auditedDetail(action: string): string | undefined {
    const call = mAudit.create.mock.calls.find((c) => c[0].data.action === action);
    return call?.[0].data.detail;
  }

  describe("poll window ends without a verified new revision (health still reports the old one)", () => {
    it("succeeded -> 200 online with the revision the relay reports, status online, success audited", async () => {
      relay({
        healthAfter: OLD_SHA,
        record: () =>
          jsonRes({ revision: NEW_SHA, state: state({ status: "succeeded" }) }),
      });
      const { res, body } = await selfUpdate();
      expect(res.status).toBe(200);
      expect(body).toEqual({
        status: "online",
        source: "relay_record",
        previousRevision: OLD_SHA,
        relayRevision: NEW_SHA,
        latestRevision: NEW_SHA,
        relayOutdated: false,
      });
      expect(mServer.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "online" }) }),
      );
      expect(auditedDetail("server.relay-self-update.success")).toContain("(relay record)");
      expect(auditedDetail("server.relay-self-update.failed")).toBeUndefined();
      // The read carries the relay token.
      expect((recordCalls[0]?.headers as Record<string, string>).Authorization).toBe(
        "Bearer secret-relay-token",
      );
    });

    it("failed -> 502 relay_reported_failed carrying the relay's error text (exit code and logs)", async () => {
      relay({
        healthAfter: OLD_SHA,
        record: () =>
          jsonRes({
            revision: OLD_SHA,
            state: state({
              status: "failed",
              error: "Helper container exited with code 17: pull access denied",
            }),
          }),
      });
      const { res, body } = await selfUpdate();
      expect(res.status).toBe(502);
      expect(body).toMatchObject({
        error: "self_update_failed",
        kind: "relay_reported_failed",
        relayStatus: "failed",
        relayError: "Helper container exited with code 17: pull access denied",
      });
      expect(body.message).toContain("exited with code 17: pull access denied");
      expect(auditedDetail("server.relay-self-update.failed")).toBe("relay_reported_failed");
    });

    it("refused is reported like failed", async () => {
      relay({
        healthAfter: OLD_SHA,
        record: () =>
          jsonRes({ revision: OLD_SHA, state: state({ status: "refused", error: "compose is build based" }) }),
      });
      const { res, body } = await selfUpdate();
      expect(res.status).toBe(502);
      expect(body).toMatchObject({ kind: "relay_reported_failed", relayStatus: "refused" });
    });

    it.each([
      ["in_progress", "relay_in_progress"],
      ["unverified", "relay_unverified"],
    ])("%s -> 202 pending (%s), distinct from a failure", async (relayStatus, kind) => {
      relay({
        healthAfter: OLD_SHA,
        record: () =>
          jsonRes({
            revision: OLD_SHA,
            state: state({ status: relayStatus, error: relayStatus === "unverified" ? "no revision label" : undefined }),
          }),
      });
      const { res, body } = await selfUpdate();
      expect(res.status).toBe(202);
      expect(body).toMatchObject({ status: "pending", kind, relayStatus });
      expect(body.error).toBeUndefined();
      expect(auditedDetail("server.relay-self-update.pending")).toBe(relayStatus);
      expect(auditedDetail("server.relay-self-update.failed")).toBeUndefined();
    });

    it("relay without the endpoint (404) keeps today's revision_unchanged result", async () => {
      relay({ healthAfter: OLD_SHA, record: () => new Response("nf", { status: 404 }) });
      const { res, body } = await selfUpdate();
      expect(res.status).toBe(502);
      expect(body).toMatchObject({ error: "self_update_failed", kind: "revision_unchanged" });
    });

    it("a failing read (network error) keeps today's result and never throws", async () => {
      relay({
        healthAfter: OLD_SHA,
        record: () => {
          throw new TypeError("fetch failed");
        },
      });
      const { res, body } = await selfUpdate();
      expect(res.status).toBe(502);
      expect(body).toMatchObject({ kind: "revision_unchanged" });
    });

    it("an unparseable record body keeps today's result", async () => {
      relay({ healthAfter: OLD_SHA, record: () => new Response("<html>", { status: 200 }) });
      const { body } = await selfUpdate();
      expect(body).toMatchObject({ kind: "revision_unchanged" });
    });

    it("no record yet (state: null) keeps today's result", async () => {
      relay({ healthAfter: OLD_SHA, record: () => jsonRes({ revision: OLD_SHA, state: null }) });
      const { body } = await selfUpdate();
      expect(body).toMatchObject({ kind: "revision_unchanged" });
    });

    it("a record of an earlier update (other previous revision) is ignored", async () => {
      relay({
        healthAfter: OLD_SHA,
        record: () =>
          jsonRes({ revision: OLD_SHA, state: state({ status: "succeeded", previousRevision: OTHER_SHA }) }),
      });
      const { body } = await selfUpdate();
      expect(body).toMatchObject({ kind: "revision_unchanged" });
    });

    it("a record aiming at another target revision is ignored", async () => {
      relay({
        healthAfter: OLD_SHA,
        record: () =>
          jsonRes({ revision: OLD_SHA, state: state({ status: "succeeded", targetRevision: OTHER_SHA }) }),
      });
      const { body } = await selfUpdate();
      expect(body).toMatchObject({ kind: "revision_unchanged" });
    });

    it("an unknown record status keeps today's result", async () => {
      relay({
        healthAfter: OLD_SHA,
        record: () => jsonRes({ revision: OLD_SHA, state: state({ status: "weird" }) }),
      });
      const { body } = await selfUpdate();
      expect(body).toMatchObject({ kind: "revision_unchanged" });
    });

    it("relay down at the end of the poll and no record: health_timeout, status from the probe classifier (unknown for a 502)", async () => {
      let healthCalls = 0;
      fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === `${RELAY}/health`) {
          healthCalls += 1;
          return healthCalls === 1
            ? jsonRes({ status: "ok", revision: OLD_SHA })
            : new Response("down", { status: 502 });
        }
        if (url === `${RELAY}/api/self-update` && init?.method === "POST") {
          return jsonRes({ status: "accepted", targetRevision: NEW_SHA }, 202);
        }
        if (url === `${RELAY}/api/self-update`) return new Response("down", { status: 502 });
        return jsonRes({}, 404);
      });
      const { body } = await selfUpdate();
      expect(body).toMatchObject({ kind: "health_timeout" });
    });
  });

  describe("source precedence", () => {
    it("a verified /health revision wins: the record is never read, even if it says failed", async () => {
      relay({
        healthAfter: NEW_SHA,
        record: () =>
          jsonRes({ revision: NEW_SHA, state: state({ status: "failed", error: "boom" }) }),
      });
      const { res, body } = await selfUpdate();
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ status: "online", relayRevision: NEW_SHA });
      expect(body.source).toBeUndefined();
      expect(recordCalls).toHaveLength(0);
      expect(auditedDetail("server.relay-self-update.success")).not.toContain("(relay record)");
    });
  });

  describe("trigger timeout", () => {
    const timeout = () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };

    it("record succeeded -> 200 online (the pull was just slow)", async () => {
      relay({
        healthAfter: NEW_SHA,
        trigger: timeout,
        record: () => jsonRes({ revision: NEW_SHA, state: state({ status: "succeeded" }) }),
      });
      const { res, body } = await selfUpdate();
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ status: "online", source: "relay_record", relayRevision: NEW_SHA });
    });

    it("record failed -> 502 relay_reported_failed", async () => {
      relay({
        healthAfter: OLD_SHA,
        trigger: timeout,
        record: () => jsonRes({ revision: OLD_SHA, state: state({ status: "failed", error: "pull denied" }) }),
      });
      const { res, body } = await selfUpdate();
      expect(res.status).toBe(502);
      expect(body).toMatchObject({ kind: "relay_reported_failed", relayError: "pull denied" });
    });

    it("record in_progress -> 202 pending without touching Server.status", async () => {
      relay({
        healthAfter: OLD_SHA,
        trigger: timeout,
        record: () => jsonRes({ revision: OLD_SHA, state: state({ status: "in_progress" }) }),
      });
      const { res, body } = await selfUpdate();
      expect(res.status).toBe(202);
      expect(body).toMatchObject({ status: "pending", kind: "relay_in_progress" });
      expect(mServer.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: expect.anything() }) }),
      );
    });

    it("record unverified -> 202 pending (relay_unverified)", async () => {
      relay({
        healthAfter: OLD_SHA,
        trigger: timeout,
        record: () => jsonRes({ revision: OLD_SHA, state: state({ status: "unverified" }) }),
      });
      const { res, body } = await selfUpdate();
      expect(res.status).toBe(202);
      expect(body).toMatchObject({ kind: "relay_unverified" });
    });

    it("endpoint missing (404) keeps 504 trigger_timeout", async () => {
      relay({ healthAfter: OLD_SHA, trigger: timeout, record: () => new Response("nf", { status: 404 }) });
      const { res, body } = await selfUpdate();
      expect(res.status).toBe(504);
      expect(body).toMatchObject({ kind: "trigger_timeout" });
    });

    it("a failing read keeps 504 trigger_timeout", async () => {
      relay({
        healthAfter: OLD_SHA,
        trigger: timeout,
        record: () => {
          throw new TypeError("fetch failed");
        },
      });
      const { res, body } = await selfUpdate();
      expect(res.status).toBe(504);
      expect(body).toMatchObject({ kind: "trigger_timeout" });
    });

    it("a stale record from an earlier update keeps 504 trigger_timeout", async () => {
      relay({
        healthAfter: OLD_SHA,
        trigger: timeout,
        record: () =>
          jsonRes({ revision: OLD_SHA, state: state({ status: "succeeded", previousRevision: OTHER_SHA }) }),
      });
      const { res, body } = await selfUpdate();
      expect(res.status).toBe(504);
      expect(body).toMatchObject({ kind: "trigger_timeout" });
    });
  });
});
