// No relay answer may make the panel buffer more than a fixed number of bytes
// (lib/relay-body.ts). This file pins the reader itself (streamed bodies, a
// lying or missing content-length, exact boundaries, decoded gzip, the socket
// release) and every relay body consumer outside stream-deploy (whose cases
// live in stream-deploy-gate.test.ts and update-relay-image-route.test.ts).
import { createServer, type Server, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// The connect-guarded transport is covered in connect-guard.test.ts; here it
// forwards to the same fetch.
vi.mock("../src/lib/guarded-fetch.js", () => ({
  guardedFetch: vi.fn((url: string, init?: RequestInit) => globalThis.fetch(url, init)),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../src/config/index.js", () => ({
  config: {
    NODE_ENV: "test",
    PANEL_TOKEN: "panel-token-must-be-16chars",
    SESSION_SECRET: "session-secret-must-be-16chars",
    CORS_ORIGINS: "http://localhost:3000",
    FRONTEND_URL: "http://localhost:3000",
    PORT: 3001,
    TRUSTED_RELAY_SERVER_IDS: [] as string[],
  },
  allowedGitHubLogins: [],
}));

// setServerStatus is stubbed (its coordination logic is covered by
// server-status.test.ts); the classifier stays real.
vi.mock("../src/services/server-status.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/server-status.js")>(
    "../src/services/server-status.js",
  );
  return { ...actual, setServerStatus: vi.fn().mockResolvedValue(true) };
});

// getLatestRelayRevision would fetch GHCR over the network; fetchRelayHealth stays real.
vi.mock("../src/lib/ghcr.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/ghcr.js")>("../src/lib/ghcr.js");
  return { ...actual, getLatestRelayRevision: vi.fn().mockResolvedValue(null) };
});

import { prisma } from "../src/lib/prisma.js";
import { RelayError, relayRequest } from "../src/lib/relay.js";
import {
  RELAY_ERROR_BODY_MAX_BYTES,
  RELAY_LOGS_MAX_BYTES,
  RELAY_RESPONSE_MAX_BYTES,
  clampLogLines,
  pendingLineTooLong,
  readRelayJson,
  readRelayText,
} from "../src/lib/relay-body.js";
import { fetchRelayHealth } from "../src/lib/ghcr.js";
import { readRelaySelfUpdateOutcome } from "../src/services/relay-self-update.js";
import { setServerStatus } from "../src/services/server-status.js";
import { serversRouter } from "../src/routes/servers.js";
import { appsRouter } from "../src/routes/apps.js";
import { v1Router } from "../src/routes/v1.js";

const MiB = 1024 * 1024;
const FILL = "ZZZZ";

const mServer = prisma.server as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
};
const mSetStatus = vi.mocked(setServerStatus);

interface StreamStats {
  pulled: number;
  cancelled: boolean;
}

/** A response whose body streams `total` bytes (Infinity = endless) of FILL in `chunkBytes` chunks. */
function streamResponse(
  total: number,
  opts: { chunkBytes?: number; status?: number; headers?: Record<string, string> } = {},
): { res: Response; stats: StreamStats } {
  const { chunkBytes = 64 * 1024, status = 200, headers = {} } = opts;
  const stats: StreamStats = { pulled: 0, cancelled: false };
  let sent = 0;
  const chunk = new TextEncoder().encode(FILL.repeat(Math.ceil(chunkBytes / FILL.length)).slice(0, chunkBytes));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      stats.pulled += 1;
      const size = Math.min(chunkBytes, total - sent);
      if (size <= 0) {
        controller.close();
        return;
      }
      controller.enqueue(size === chunkBytes ? chunk : chunk.subarray(0, size));
      sent += size;
    },
    cancel() {
      stats.cancelled = true;
    },
  });
  return { res: new Response(body, { status, headers }), stats };
}

/** A JSON document (one string) of exactly `bytes` UTF-8 bytes. */
function jsonOfSize(bytes: number): string {
  return JSON.stringify("x".repeat(bytes - 2));
}

/** `text` delivered in chunks of `chunkBytes` (the last one shorter). */
function chunkedResponse(text: string, chunkBytes: number, init: ResponseInit = {}): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + chunkBytes));
      offset += chunkBytes;
    },
  });
  return new Response(body, init);
}

describe("readRelayJson / readRelayText", () => {
  const CAP = 1 * MiB;

  it("fails an over-cap streamed body without content-length, names the cap, leaks no body, and cancels the stream", async () => {
    const { res, stats } = streamResponse(16 * MiB);
    const err = await readRelayJson(res, { maxBytes: CAP }).catch((e) => e);

    expect(err).toBeInstanceOf(RelayError);
    expect(err.status).toBe(502);
    expect(err.local).toBe(false);
    expect(err.message).toContain(String(CAP));
    expect(err.message).not.toContain(FILL);
    expect(err.body).toBeUndefined();
    expect(stats.cancelled).toBe(true);
    // The reader stopped within a few chunks of the cap instead of draining the 16 MiB body.
    expect(stats.pulled * 64 * 1024).toBeLessThanOrEqual(CAP + 4 * 64 * 1024);
  });

  it("is not raised by a lying (smaller) content-length", async () => {
    const { res, stats } = streamResponse(3 * MiB, { headers: { "content-length": "10" } });
    const err = await readRelayText(res, { maxBytes: CAP }).catch((e) => e);

    expect(err).toBeInstanceOf(RelayError);
    expect(err.status).toBe(502);
    expect(stats.cancelled).toBe(true);
  });

  it("refuses a content-length above the cap before reading a byte, and releases the body", async () => {
    const { res, stats } = streamResponse(1024, { headers: { "content-length": String(CAP + 1) } });
    const getReader = vi.spyOn(res.body!, "getReader");
    const err = await readRelayJson(res, { maxBytes: CAP }).catch((e) => e);

    expect(err).toBeInstanceOf(RelayError);
    expect(err.status).toBe(502);
    expect(getReader).not.toHaveBeenCalled();
    expect(stats.cancelled).toBe(true);
  });

  it("accepts a body of exactly the cap and one byte under it, across chunk boundaries, and fails one byte over", async () => {
    const at = await readRelayJson<string>(chunkedResponse(jsonOfSize(CAP), 1000), { maxBytes: CAP });
    expect(at).toHaveLength(CAP - 2);
    const under = await readRelayJson<string>(chunkedResponse(jsonOfSize(CAP - 1), 1000), { maxBytes: CAP });
    expect(under).toHaveLength(CAP - 3);

    await expect(readRelayJson(chunkedResponse(jsonOfSize(CAP + 1), 1000), { maxBytes: CAP })).rejects.toMatchObject({
      status: 502,
    });
    // A content-length equal to the cap is not a refusal either.
    const atWithHeader = chunkedResponse(jsonOfSize(CAP), 4096, { headers: { "content-length": String(CAP) } });
    expect(await readRelayText(atWithHeader, { maxBytes: CAP })).toHaveLength(CAP);
  });

  it("counts decoded bytes, not characters", async () => {
    // 2 bytes per character: CAP / 2 + 1 characters are CAP + 2 bytes.
    const twoByte = "é".repeat(CAP / 2 + 1);
    await expect(readRelayText(new Response(twoByte), { maxBytes: CAP })).rejects.toMatchObject({ status: 502 });
    expect(await readRelayText(new Response("é".repeat(CAP / 2)), { maxBytes: CAP })).toHaveLength(CAP / 2);
  });

  it("keeps the behaviour of response.json() for an empty body, invalid JSON and a BOM", async () => {
    await expect(readRelayJson(new Response(""))).rejects.toBeInstanceOf(SyntaxError);
    await expect(readRelayJson(new Response(null))).rejects.toBeInstanceOf(SyntaxError);
    await expect(readRelayJson(new Response("<html>"))).rejects.toBeInstanceOf(SyntaxError);
    expect(await readRelayJson(new Response('﻿{"a":1}'))).toEqual({ a: 1 });
    expect(await readRelayText(new Response(null))).toBe("");
    // The default cap is the relay answer cap.
    await expect(readRelayText(new Response("a".repeat(RELAY_RESPONSE_MAX_BYTES + 1)))).rejects.toMatchObject({ status: 502 });
  });

  it("truncate cuts an over-cap text at the cap instead of failing, stops reading, and ignores content-length", async () => {
    const { res, stats } = streamResponse(4 * MiB, { chunkBytes: 10_000, headers: { "content-length": String(10 * CAP) } });
    const text = await readRelayText(res, { maxBytes: RELAY_ERROR_BODY_MAX_BYTES, truncate: true });

    expect(text).toHaveLength(RELAY_ERROR_BODY_MAX_BYTES);
    expect(text.startsWith(FILL)).toBe(true);
    expect(stats.cancelled).toBe(true);
    expect(stats.pulled).toBeLessThanOrEqual(10);

    // A multi-byte character cut in half is replaced, never an error.
    const cut = await readRelayText(new Response("é".repeat(10)), { maxBytes: 5, truncate: true });
    expect(cut).toBe("éé�");
    // Under the cap nothing is cut.
    expect(await readRelayText(new Response("short"), { maxBytes: 1024, truncate: true })).toBe("short");
  });

  it("pendingLineTooLong compares UTF-8 bytes", () => {
    expect(pendingLineTooLong("a".repeat(10), 10)).toBe(false);
    expect(pendingLineTooLong("a".repeat(11), 10)).toBe(true);
    // Two bytes per character: 5 characters are exactly 10 bytes.
    expect(pendingLineTooLong("é".repeat(5), 10)).toBe(false);
    expect(pendingLineTooLong("é".repeat(6), 10)).toBe(true);
    expect(pendingLineTooLong("é".repeat(4), 10)).toBe(false);
  });
});

describe("caps", () => {
  it("are the documented values", () => {
    expect(RELAY_RESPONSE_MAX_BYTES).toBe(8 * MiB);
    expect(RELAY_LOGS_MAX_BYTES).toBe(40 * MiB);
    expect(RELAY_ERROR_BODY_MAX_BYTES).toBe(64 * 1024);
  });
});

const SERVER_ROW = {
  id: "srv-1",
  userId: null,
  name: "my-server",
  host: "203.0.113.10",
  status: "online",
  relayUrl: "https://relay.example.test",
  relayToken: "tok",
  sshKeyPath: null,
  hostKeySha256: null,
  relayMode: null,
  relayDir: null,
  relayComposeFile: null,
  lastSeenAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mServer.findUnique.mockResolvedValue(SERVER_ROW);
  mServer.findFirst.mockResolvedValue(SERVER_ROW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function fetchReturning(...responses: Array<() => Response>) {
  const queue = [...responses];
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    return next();
  });
}

describe("relayRequest", () => {
  it("returns an answer under the cap", async () => {
    fetchReturning(() => Response.json({ ok: true }));
    expect(await relayRequest({ serverId: "srv-1", path: "/api/x" })).toEqual({ ok: true });
  });

  it("fails with a 502 RelayError and cancels the stream when the answer is over the default cap", async () => {
    const { res, stats } = streamResponse(RELAY_RESPONSE_MAX_BYTES + MiB);
    fetchReturning(() => res);

    const err = await relayRequest({ serverId: "srv-1", path: "/api/x" }).catch((e) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect(err.status).toBe(502);
    expect(err.message).toContain(String(RELAY_RESPONSE_MAX_BYTES));
    expect(stats.cancelled).toBe(true);
  });

  it("honours maxResponseBytes: a 9 MiB answer passes with the logs cap and fails with the default", async () => {
    const body = JSON.stringify({ logs: "x".repeat(9 * MiB) });
    fetchReturning(() => new Response(body, { headers: { "content-type": "application/json" } }));
    const viaLogsCap = await relayRequest<{ logs: string }>({
      serverId: "srv-1",
      path: "/api/x",
      maxResponseBytes: RELAY_LOGS_MAX_BYTES,
    });
    expect(viaLogsCap.logs).toHaveLength(9 * MiB);

    await expect(relayRequest({ serverId: "srv-1", path: "/api/x" })).rejects.toMatchObject({ status: 502 });
  });

  it("cuts the error body of a non-2xx answer at 64 KiB and keeps the relay's status", async () => {
    const { res, stats } = streamResponse(200 * 1024, { status: 500 });
    fetchReturning(() => res);

    const err = await relayRequest({ serverId: "srv-1", path: "/api/x" }).catch((e) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect(err.status).toBe(500);
    expect(err.body).toHaveLength(RELAY_ERROR_BODY_MAX_BYTES);
    expect(err.message).toBe(`Relay error (500): ${err.body}`);
    expect(stats.cancelled).toBe(true);
  });

  it("a short error body is unchanged", async () => {
    fetchReturning(() => new Response("unknown app", { status: 404 }));
    await expect(relayRequest({ serverId: "srv-1", path: "/api/x" })).rejects.toMatchObject({
      status: 404,
      body: "unknown app",
    });
  });
});

describe("relayRequest over a real connection", () => {
  let httpServer: Server | undefined;

  afterEach(async () => {
    httpServer?.closeAllConnections();
    await new Promise<void>((resolve) => (httpServer ? httpServer.close(() => resolve()) : resolve()));
    httpServer = undefined;
  });

  async function listen(handler: (res: ServerResponse) => void): Promise<string> {
    httpServer = createServer((_req, res) => handler(res));
    await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  }

  it("counts decoded bytes: a small gzip answer that inflates past the cap fails", async () => {
    const inflated = JSON.stringify({ logs: "0".repeat(RELAY_RESPONSE_MAX_BYTES + MiB) });
    const gz = gzipSync(inflated);
    expect(gz.byteLength).toBeLessThan(64 * 1024);
    const url = await listen((res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(gz);
    });
    mServer.findUnique.mockResolvedValue({ ...SERVER_ROW, relayUrl: url });

    await expect(relayRequest({ serverId: "srv-1", path: "/" })).rejects.toMatchObject({ status: 502 });
  });

  it("releases the socket: a 64 MiB answer stops being written once the cap is hit", async () => {
    const total = 64 * MiB;
    let written = 0;
    let completed = false;
    let closed!: Promise<void>;
    const url = await listen((res) => {
      closed = new Promise<void>((resolve) => res.on("close", resolve));
      res.writeHead(200, { "content-type": "application/json" });
      const block = Buffer.alloc(64 * 1024, "Z");
      const pump = () => {
        while (!res.destroyed) {
          if (written >= total) {
            completed = true;
            res.end();
            return;
          }
          written += block.byteLength;
          if (!res.write(block)) {
            res.once("drain", pump);
            return;
          }
        }
      };
      pump();
    });
    mServer.findUnique.mockResolvedValue({ ...SERVER_ROW, relayUrl: url });

    await expect(relayRequest({ serverId: "srv-1", path: "/" })).rejects.toMatchObject({ status: 502 });
    await closed;
    // The client hung up: the server did not get to write its whole answer.
    expect(completed).toBe(false);
    expect(written).toBeLessThan(total);
  });
});

type ActorVars = { Variables: { userId?: string; isAdmin?: boolean; authType?: string } };

function adminApp() {
  const app = new Hono<ActorVars>();
  app.use("/*", async (c, next) => {
    c.set("isAdmin", true);
    c.set("authType", "panel");
    await next();
  });
  app.route("/servers", serversRouter as unknown as Hono<ActorVars>);
  app.route("/servers/:serverId/apps", appsRouter as unknown as Hono<ActorVars>);
  app.route("/v1", v1Router as unknown as Hono<ActorVars>);
  return app;
}

/** A JSON object `{ [key]: "x..." }` of at least `bytes` bytes. */
const bigObject = (key: string, bytes: number) => JSON.stringify({ [key]: "x".repeat(bytes) });

describe("servers routes", () => {
  it("POST /:id/test: an over-cap /health answer is an unusable answer (unknown), not online", async () => {
    fetchReturning(() => new Response(bigObject("status", RELAY_RESPONSE_MAX_BYTES + 1)));
    const res = await adminApp().request("/servers/srv-1/test", { method: "POST" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("unknown");
    expect(body.message).toContain(String(RELAY_RESPONSE_MAX_BYTES));
    expect(mSetStatus).toHaveBeenCalledWith(expect.objectContaining({ serverId: "srv-1", status: "unknown" }));
    expect(mSetStatus).not.toHaveBeenCalledWith(expect.objectContaining({ status: "online" }));
  });

  it("POST /:id/test: a small /health answer is still online", async () => {
    fetchReturning(() => Response.json({ status: "ok", version: "1.0.0" }));
    const body = await (await adminApp().request("/servers/srv-1/test", { method: "POST" })).json();
    expect(body.status).toBe("online");
  });

  it("GET /:id/system: an over-cap answer is the existing 502, an in-cap one is passed through", async () => {
    fetchReturning(() => new Response(bigObject("cpu", RELAY_RESPONSE_MAX_BYTES + 1)));
    const over = await adminApp().request("/servers/srv-1/system");
    expect(over.status).toBe(502);
    expect(await over.json()).toEqual({ error: "unreachable" });

    fetchReturning(() => Response.json({ cpu: 3 }));
    const ok = await adminApp().request("/servers/srv-1/system");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ cpu: 3 });
  });

  it("POST /:id/relay-self-update: an over-cap trigger answer is an unreadable body (its message is not used)", async () => {
    mServer.findUnique.mockResolvedValue({ ...SERVER_ROW, relayMode: "greenfield", relayDir: "/opt/agent-relay" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/health")) return Response.json({ status: "ok", revision: "89b3f8b920be3ae58617395fddb4d73fe5138f72" });
      if (url.endsWith("/api/self-update") && init?.method === "POST") {
        return new Response(bigObject("error", RELAY_RESPONSE_MAX_BYTES + 1), { status: 409 });
      }
      return new Response("{}", { status: 404 });
    });

    const res = await adminApp().request("/servers/srv-1/relay-self-update", { method: "POST" });
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.kind).toBe("relay_busy");
    expect(body.message).toBe(
      "Relay is currently busy with a deploy, rollback, or self-update. Try again once it finishes.",
    );
  });

  it("POST /:id/relay-self-update: an in-cap trigger answer still supplies its message", async () => {
    mServer.findUnique.mockResolvedValue({ ...SERVER_ROW, relayMode: "greenfield", relayDir: "/opt/agent-relay" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/health")) return Response.json({ status: "ok", revision: "89b3f8b920be3ae58617395fddb4d73fe5138f72" });
      if (url.endsWith("/api/self-update") && init?.method === "POST") {
        return Response.json({ error: "busy right now" }, { status: 409 });
      }
      return new Response("{}", { status: 404 });
    });

    const res = await adminApp().request("/servers/srv-1/relay-self-update", { method: "POST" });
    expect((await res.json()).message).toBe("busy right now");
  });
});

describe("readRelaySelfUpdateOutcome", () => {
  const OLD_SHA = "89b3f8b920be3ae58617395fddb4d73fe5138f72";
  const opts = () => ({
    server: SERVER_ROW,
    guarded: false,
    previousRevision: OLD_SHA,
    targetRevision: null,
    mode: "timeout" as const,
    notBefore: Date.now(),
  });
  const record = (padding: number) =>
    JSON.stringify({
      revision: OLD_SHA,
      state: { status: "in_progress", requestedAt: new Date().toISOString(), previousRevision: OLD_SHA },
      padding: "x".repeat(padding),
    });

  it("reads an in-cap record", async () => {
    fetchReturning(() => new Response(record(10)));
    expect(await readRelaySelfUpdateOutcome(opts())).toEqual({
      kind: "pending",
      relayStatus: "in_progress",
      error: null,
    });
  });

  it("maps an over-cap record to none", async () => {
    fetchReturning(() => new Response(record(RELAY_RESPONSE_MAX_BYTES)));
    expect(await readRelaySelfUpdateOutcome(opts())).toEqual({ kind: "none" });
  });
});

describe("fetchRelayHealth", () => {
  it("reads an in-cap health answer", async () => {
    fetchReturning(() => Response.json({ status: "ok", version: "1.2.3" }));
    const probe = await fetchRelayHealth(SERVER_ROW, 5000, false);
    expect(probe).toMatchObject({ online: true, version: "1.2.3" });
  });

  it("treats an over-cap answer as an unreadable body: online, no data", async () => {
    fetchReturning(() => new Response(bigObject("version", RELAY_RESPONSE_MAX_BYTES + 1)));
    const probe = await fetchRelayHealth(SERVER_ROW, 5000, false);
    expect(probe).toMatchObject({ online: true, status: 200, version: null, revision: null, data: null, failureStatus: null });
  });
});

describe("logs routes", () => {
  const logsAnswer = (bytes: number) => new Response(JSON.stringify({ logs: "x".repeat(bytes) }));
  const routes = [
    { label: "apps", url: (q: string) => `/servers/srv-1/apps/my-app/logs${q}` },
    { label: "v1", url: (q: string) => `/v1/logs?server=my-server&app=my-app${q ? `&${q.slice(1)}` : ""}` },
  ];

  describe.each(routes)("$label", ({ url }) => {
    it("passes a 9 MiB logs answer (over the default cap, under the logs cap)", async () => {
      fetchReturning(() => logsAnswer(9 * MiB));
      const res = await adminApp().request(url(""));
      expect(res.status).toBe(200);
      expect((await res.json()).logs).toHaveLength(9 * MiB);
    });

    it("fails an answer over the logs cap with a 502 and stops reading", async () => {
      const { res: relayRes, stats } = streamResponse(RELAY_LOGS_MAX_BYTES + 8 * MiB, { chunkBytes: MiB });
      fetchReturning(() => relayRes);
      const res = await adminApp().request(url(""));
      expect(res.status).toBe(502);
      expect((await res.json()).error).toContain(String(RELAY_LOGS_MAX_BYTES));
      expect(stats.cancelled).toBe(true);
      expect(stats.pulled).toBeLessThan(RELAY_LOGS_MAX_BYTES / MiB + 4);
    });

    it.each([
      ["absent", "", 50],
      ["empty", "?lines=", 50],
      ["abc", "?lines=abc", 50],
      ["0", "?lines=0", 50],
      ["-5", "?lines=-5", 1],
      ["0.5", "?lines=0.5", 1],
      ["7", "?lines=7", 7],
      ["1000", "?lines=1000", 1000],
      ["5000", "?lines=5000", 1000],
    ])("lines %s reaches the relay as %i", async (_label, query, expected) => {
      const spy = fetchReturning(() => Response.json({ logs: "" }));
      const res = await adminApp().request(url(query));
      expect(res.status).toBe(200);
      expect(String(spy.mock.calls[0][0])).toMatch(new RegExp(`/api/apps/my-app/logs\\?lines=${expected}$`));
    });
  });

  it("clampLogLines: not a number and absent give 50, below 1 gives 1, above 1000 gives 1000", () => {
    expect(clampLogLines(undefined)).toBe(50);
    expect(clampLogLines("abc")).toBe(50);
    expect(clampLogLines("0")).toBe(50);
    expect(clampLogLines("-5")).toBe(1);
    expect(clampLogLines("5000")).toBe(1000);
    expect(clampLogLines("42")).toBe(42);
  });
});
