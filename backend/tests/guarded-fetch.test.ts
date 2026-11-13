// Transport behaviour of the guarded request path once the classifier lets an
// address through. The classifier is replaced by "everything is public" so a
// local listener can stand for the relay; refusals are covered with the real
// classifier in connect-guard.test.ts.
import type dns from "node:dns";
import { EventEmitter } from "node:events";
import http, { createServer, type IncomingMessage, type Server } from "node:http";
import { connect as netConnect, createServer as createTcpServer, type AddressInfo, type Server as TcpServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/probe-guard.js", () => ({
  isPrivateOrLoopbackHost: () => false,
  isTrustedRelayServer: () => false,
}));

import { _setConnectResolver, guardedLookup } from "../src/lib/connect-guard.js";
import { guardedFetch } from "../src/lib/guarded-fetch.js";
import { classifyProbeError } from "../src/services/server-status.js";
import { RELAY_REDIRECT_MESSAGE, relayFetch } from "../src/lib/relay-fetch.js";
import { executeSshCommand, SshError } from "../src/services/ssh-executor.js";

let resolverCalls: string[];
let server: Server;
let port: number;
let connections: number;
let seen: { method?: string; url?: string; headers: IncomingMessage["headers"]; body: string }[];

beforeEach(async () => {
  resolverCalls = [];
  _setConnectResolver((host, cb) => {
    resolverCalls.push(host);
    cb(null, [{ address: "127.0.0.1", family: 4 }] satisfies dns.LookupAddress[]);
  });
  seen = [];
  connections = 0;
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://127.0.0.1:1/secret" });
        res.end("moved");
      } else if (req.url === "/empty") {
        res.writeHead(204);
        res.end();
      } else if (req.url === "/stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": ping\n\n");
        // keep the connection open until the client goes away
      } else if (req.url === "/status600") {
        res.writeHead(600);
        res.end("x");
      } else if (req.url === "/slow") {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        }, 150);
      } else if (req.url === "/err") {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "busy" }));
      } else {
        res.writeHead(200, { "content-type": "application/json", "x-relay": "yes" });
        res.end(JSON.stringify({ echoed: body }));
      }
    });
  });
  server.on("connection", () => {
    connections++;
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  vi.restoreAllMocks();
  _setConnectResolver(null);
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("guardedFetch", () => {
  it("connects to the address its lookup returned, resolving the name once", async () => {
    const res = await guardedFetch(`http://relay.test:${port}/api/x`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok", "X-Deploy-Id": "d-1" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-relay")).toBe("yes");
    expect(await res.json()).toEqual({ echoed: '{"a":1}' });
    expect(resolverCalls).toEqual(["relay.test"]);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers.authorization).toBe("Bearer tok");
    expect(seen[0].headers["x-deploy-id"]).toBe("d-1");
    expect(seen[0].headers["content-length"]).toBe("7");
  });

  it("does not call the lookup for an IP literal and still connects", async () => {
    const res = await guardedFetch(`http://127.0.0.1:${port}/api/x`);
    expect(res.status).toBe(200);
    expect(resolverCalls).toEqual([]);
  });

  it("returns a 4xx body and a null-body status like fetch", async () => {
    const err = await guardedFetch(`http://relay.test:${port}/err`);
    expect(err.status).toBe(409);
    expect(await err.json()).toEqual({ error: "busy" });
    const empty = await guardedFetch(`http://relay.test:${port}/empty`);
    expect(empty.status).toBe(204);
    expect(empty.body).toBeNull();
  });

  it("streams the body and an abort of the signal errors the read", async () => {
    const ac = new AbortController();
    const res = await guardedFetch(`http://relay.test:${port}/stream`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(": ping\n\n");
    const pending = reader.read();
    ac.abort(new Error("idle"));
    await expect(pending).rejects.toBeDefined();
  });

  it("rejects with the signal's reason when aborted before the response", async () => {
    const ac = new AbortController();
    ac.abort(new Error("already"));
    await expect(guardedFetch(`http://relay.test:${port}/api/x`, { signal: ac.signal })).rejects.toThrow("already");
    expect(seen).toHaveLength(0);
  });

  it("rejects a non-http protocol and a non-string body", async () => {
    await expect(guardedFetch("ftp://relay.test/x")).rejects.toBeInstanceOf(TypeError);
    await expect(guardedFetch(`http://relay.test:${port}/x`, { method: "POST", body: new URLSearchParams("a=1") })).rejects.toBeInstanceOf(TypeError);
  });
});

describe("guardedFetch: socket reuse, errors and the connect timeout", () => {
  it("opens a fresh connection per request (no keep-alive pool)", async () => {
    await (await guardedFetch(`http://relay.test:${port}/api/x`)).text();
    await (await guardedFetch(`http://relay.test:${port}/api/x`)).text();
    expect(connections).toBe(2);
    expect(resolverCalls).toEqual(["relay.test", "relay.test"]);
  });

  it("reports a transport failure the way undici does, so the probe classifier says offline", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const err = await guardedFetch(`http://relay.test:${closedPort}/x`).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe("fetch failed");
    expect(err.cause.code).toBe("ECONNREFUSED");
    expect(classifyProbeError(err)).toBe("offline");
  });

  it("an answer fetch cannot represent (status 600) is a transport failure, not a raw RangeError", async () => {
    const err = await guardedFetch(`http://relay.test:${port}/status600`).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe("fetch failed");
    expect(err.cause).toBeInstanceOf(RangeError);
  });

  it("keeps the abort reason of the signal as it is (a timeout is unknown, not offline)", async () => {
    const err = await guardedFetch(`http://relay.test:${port}/slow`, { signal: AbortSignal.timeout(30) }).catch((e) => e);
    expect(err.name).toBe("TimeoutError");
    expect(classifyProbeError(err)).toBe("unknown");
  });

  it("gives up on a connection that never completes with an ETIMEDOUT cause (fake socket)", async () => {
    const destroyed: unknown[] = [];
    vi.spyOn(http, "request").mockImplementation((() => {
      const req = new EventEmitter() as EventEmitter & { destroy: (e: Error) => void; end: () => void };
      req.destroy = (e) => {
        destroyed.push(e);
        queueMicrotask(() => req.emit("error", e));
      };
      req.end = () => {
        const socket = Object.assign(new EventEmitter(), { connecting: true });
        queueMicrotask(() => req.emit("socket", socket));
      };
      return req;
    }) as never);
    const err = await guardedFetch(`http://relay.test:${port}/x`, {}, { connectTimeoutMs: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe("fetch failed");
    expect(err.cause.code).toBe("ETIMEDOUT");
    expect(destroyed).toHaveLength(1);
    expect(classifyProbeError(err)).toBe("offline");
  });

  it("times out against an address that drops the SYN (127.0.0.2 on macOS; skipped where the OS answers)", async (ctx) => {
    const blackholed = await new Promise<boolean>((resolve) => {
      const probe = netConnect({ host: "127.0.0.2", port, timeout: 300 });
      probe.once("connect", () => (probe.destroy(), resolve(false)));
      probe.once("error", () => resolve(false));
      probe.once("timeout", () => (probe.destroy(), resolve(true)));
    });
    if (!blackholed) return ctx.skip();
    _setConnectResolver((host, cb) => cb(null, [{ address: "127.0.0.2", family: 4 }]));
    const started = Date.now();
    const err = await guardedFetch(`http://relay.test:${port}/x`, {}, { connectTimeoutMs: 150 }).catch((e) => e);
    expect(err.cause.code).toBe("ETIMEDOUT");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("stops the connect timer once connected, so a slow answer is not cut off", async () => {
    const res = await guardedFetch(`http://relay.test:${port}/slow`, {}, { connectTimeoutMs: 50 });
    expect(res.status).toBe(200);
  });
});

describe("guardedLookup option pass-through", () => {
  const call = (host: string, options: unknown) =>
    new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) => {
      (guardedLookup as unknown as (h: string, o: unknown, cb: (e: Error | null, a: unknown, f?: number) => void) => void)(
        host,
        options,
        (err, address, family) => resolve({ err, address, family }),
      );
    });
  const mixed = [
    { address: "203.0.113.9", family: 4 },
    { address: "2001:db8::1", family: 6 },
  ];

  it("filters to the requested family (object or number) and refuses when none is left", async () => {
    _setConnectResolver((_h, cb) => cb(null, mixed));
    expect(await call("x.test", { family: 6 })).toMatchObject({ address: "2001:db8::1", family: 6 });
    expect(await call("x.test", 4)).toMatchObject({ address: "203.0.113.9", family: 4 });
    _setConnectResolver((_h, cb) => cb(null, [mixed[0]]));
    expect((await call("x.test", { family: 6 })).err).toMatchObject({ code: "ECONNDENIED" });
  });

  it("answers an array for all:true and a single address otherwise", async () => {
    _setConnectResolver((_h, cb) => cb(null, mixed));
    expect((await call("x.test", { all: true })).address).toEqual(mixed);
    expect(await call("x.test", {})).toMatchObject({ address: "203.0.113.9", family: 4 });
  });
});

describe("relayFetch guarded", () => {
  it("never follows a redirect and hides what the redirecting host sent", async () => {
    const res = await relayFetch(`http://relay.test:${port}/redirect`, {}, { guarded: true });
    expect(res.status).toBe(502);
    expect(await res.text()).toBe(RELAY_REDIRECT_MESSAGE);
    expect(seen.map((s) => s.url)).toEqual(["/redirect"]);
  });
});

describe("executeSshCommand with guardTarget", () => {
  it("resolves the name once and connects ssh2 to the checked address", async () => {
    let connections = 0;
    const tcp: TcpServer = createTcpServer((socket) => {
      connections++;
      socket.destroy();
    });
    await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
    const tcpPort = (tcp.address() as AddressInfo).port;
    try {
      await expect(
        executeSshCommand({
          host: "ssh.test",
          port: tcpPort,
          user: "root",
          auth: { kind: "password", password: "x" },
          command: "true",
          timeoutMs: 3000,
          guardTarget: true,
        }),
      ).rejects.toBeInstanceOf(SshError);
      expect(resolverCalls).toEqual(["ssh.test"]);
      expect(connections).toBe(1);
    } finally {
      await new Promise<void>((r) => tcp.close(() => r()));
    }
  });
});
