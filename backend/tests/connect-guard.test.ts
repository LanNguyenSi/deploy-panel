// Connect-time half of the non-admin private-target guard, with the real
// classifier and real sockets. A local HTTP listener (and a local TCP
// listener for SSH) stands for the internal service; a stub resolver stands
// for DNS. A refused connection is proven by the listener seeing nothing.
import dns from "node:dns";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SERVER_ROW = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("../src/config/index.js", () => ({
  config: { TRUSTED_RELAY_SERVER_IDS: ["srv-trusted"] },
  allowedGitHubLogins: [],
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: { findUnique: vi.fn(async () => SERVER_ROW.current) },
    app: { findUnique: vi.fn().mockResolvedValue({ requiredEnvKeys: [] }), update: vi.fn().mockResolvedValue({}) },
    deploy: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("../src/lib/provision-secrets.js", () => ({
  provisionAndCheckAppSecrets: vi.fn().mockResolvedValue({ provisionedKeys: [], wrote: false, missing: [] }),
}));

vi.mock("../src/lib/deploy-recovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/deploy-recovery.js")>();
  return { ...actual, recoverBrokenDeploy: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../src/lib/post-deploy-gate.js", () => ({
  verifyDeployHealth: vi.fn().mockResolvedValue({ healthy: true }),
}));

import {
  _setConnectResolver,
  connectGuardRequired,
  connectGuardRequiredForActor,
  resolveCheckedAddresses,
} from "../src/lib/connect-guard.js";
import { relayRequest } from "../src/lib/relay.js";
import { relayFetch } from "../src/lib/relay-fetch.js";
import { streamDeploy } from "../src/lib/stream-deploy.js";
import { recoverBrokenDeploy } from "../src/lib/deploy-recovery.js";
import { assertServerTargetsAllowed } from "../src/services/probe-guard.js";
import { executeSshCommand, SshError } from "../src/services/ssh-executor.js";

type Answer = { address: string; family: 4 | 6 }[] | Error;

/** Stub resolver: answers come from `answers` in order, the last one repeats. */
function stubResolver(answers: Answer[]) {
  const calls: string[] = [];
  const fn = (host: string, cb: (err: NodeJS.ErrnoException | null, a: dns.LookupAddress[]) => void) => {
    calls.push(host);
    const next = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (next instanceof Error) cb(next as NodeJS.ErrnoException, []);
    else cb(null, next);
  };
  return { fn, calls };
}

const PUBLIC: Answer = [{ address: "203.0.113.9", family: 4 }];
const PRIVATE: Answer = [{ address: "127.0.0.1", family: 4 }];

let http: Server;
let hits: number;
let relayUrlBase: string;
let tcp: TcpServer;
let tcpConnections: number;
let tcpPort: number;

beforeEach(async () => {
  hits = 0;
  http = createServer((req, res) => {
    hits++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => http.listen(0, r));
  relayUrlBase = `${(http.address() as AddressInfo).port}`;

  tcpConnections = 0;
  tcp = createTcpServer((socket) => {
    tcpConnections++;
    socket.destroy();
  });
  await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
  tcpPort = (tcp.address() as AddressInfo).port;
});

afterEach(async () => {
  _setConnectResolver(null);
  vi.restoreAllMocks();
  SERVER_ROW.current = null;
  http.closeAllConnections();
  await new Promise<void>((r) => http.close(() => r()));
  await new Promise<void>((r) => tcp.close(() => r()));
});

const row = (over: Record<string, unknown>) => ({
  id: "srv-owned",
  userId: "user-1",
  relayToken: "tok",
  ...over,
});

describe("who is guarded", () => {
  it("guards an owned, unlisted row; not an unowned row, a listed row or a missing row", () => {
    expect(connectGuardRequired({ id: "srv-owned", userId: "u" })).toBe(true);
    expect(connectGuardRequired({ id: "srv-owned", userId: null })).toBe(false);
    expect(connectGuardRequired({ id: "srv-trusted", userId: "u" })).toBe(false);
    expect(connectGuardRequired({ userId: "u" })).toBe(true);
    expect(connectGuardRequired(undefined)).toBe(false);
    expect(connectGuardRequired(null)).toBe(false);
    expect(connectGuardRequired({ id: "srv-owned", userId: "u" }, { isAdmin: true })).toBe(false);
    expect(connectGuardRequired({ id: "srv-owned", userId: "u" }, { isAdmin: false })).toBe(true);
  });

  it("actor variant: admin never, non-admin unless the stored row is listed", () => {
    expect(connectGuardRequiredForActor({ isAdmin: true })).toBe(false);
    expect(connectGuardRequiredForActor({ isAdmin: true }, "srv-owned")).toBe(false);
    expect(connectGuardRequiredForActor({ isAdmin: false })).toBe(true);
    expect(connectGuardRequiredForActor({ isAdmin: false }, "srv-owned")).toBe(true);
    expect(connectGuardRequiredForActor({ isAdmin: false }, "srv-trusted")).toBe(false);
  });
});

describe("resolveCheckedAddresses", () => {
  it("returns a public answer", async () => {
    _setConnectResolver(stubResolver([PUBLIC]).fn);
    await expect(resolveCheckedAddresses("relay.example")).resolves.toEqual([{ address: "203.0.113.9", family: 4 }]);
  });

  it("refuses when any of several answers is private", async () => {
    _setConnectResolver(
      stubResolver([[{ address: "203.0.113.9", family: 4 }, { address: "::ffff:10.0.0.5", family: 6 }]]).fn,
    );
    await expect(resolveCheckedAddresses("relay.example")).rejects.toMatchObject({ code: "ECONNDENIED", reason: "resolved_private" });
  });

  it("refuses a lookup error and an empty answer", async () => {
    _setConnectResolver(stubResolver([Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })]).fn);
    await expect(resolveCheckedAddresses("relay.example")).rejects.toMatchObject({ code: "ECONNDENIED", reason: "lookup_failed" });
    _setConnectResolver(stubResolver([[]]).fn);
    await expect(resolveCheckedAddresses("relay.example")).rejects.toMatchObject({ reason: "lookup_failed" });
  });

  it("classifies IP literals without calling the resolver", async () => {
    const stub = stubResolver([PRIVATE]);
    _setConnectResolver(stub.fn);
    await expect(resolveCheckedAddresses("127.0.0.1")).rejects.toMatchObject({ reason: "literal" });
    await expect(resolveCheckedAddresses("[::1]")).rejects.toMatchObject({ reason: "literal" });
    await expect(resolveCheckedAddresses("169.254.169.254")).rejects.toMatchObject({ reason: "literal" });
    await expect(resolveCheckedAddresses("localhost")).rejects.toMatchObject({ reason: "literal" });
    await expect(resolveCheckedAddresses("93.184.216.34")).resolves.toEqual([{ address: "93.184.216.34", family: 4 }]);
    expect(stub.calls).toEqual([]);
  });

  it("a family that leaves nothing is a refusal, not a fallback to the other family", async () => {
    _setConnectResolver(stubResolver([[{ address: "203.0.113.9", family: 4 }]]).fn);
    await expect(resolveCheckedAddresses("relay.example", 6)).rejects.toMatchObject({ reason: "lookup_failed" });
  });
});

describe("relayRequest for a server with an owner", () => {
  it("refuses when the name was public at the pre-check and flips to a private address at connect", async () => {
    const stub = stubResolver([PUBLIC, PRIVATE]);
    _setConnectResolver(stub.fn);
    // The pre-check (probe-guard) resolves through dns.promises.lookup; route
    // it to the same stub so call 1 is the check and call 2 is the connection.
    vi.spyOn(dns.promises, "lookup").mockImplementation((async (host: string) =>
      new Promise((resolve, reject) =>
        stub.fn(host, (err, a) => (err ? reject(err) : resolve(a))),
      )) as never);
    SERVER_ROW.current = row({ relayUrl: `http://relay.flip.test:${relayUrlBase}` });

    const check = await assertServerTargetsAllowed(
      { isAdmin: false },
      { relayUrl: `http://relay.flip.test:${relayUrlBase}` },
      "srv-owned",
    );
    expect(check).toEqual({ ok: true });
    expect(stub.calls).toHaveLength(1);

    await expect(relayRequest({ serverId: "srv-owned", path: "/health" })).rejects.toMatchObject({ code: "ECONNDENIED" });
    expect(stub.calls).toHaveLength(2);
    expect(hits).toBe(0);
  });

  it("refuses when the lookup fails", async () => {
    _setConnectResolver(stubResolver([Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })]).fn);
    SERVER_ROW.current = row({ relayUrl: `http://relay.down.test:${relayUrlBase}` });
    await expect(relayRequest({ serverId: "srv-owned", path: "/health" })).rejects.toMatchObject({ code: "ECONNDENIED" });
    expect(hits).toBe(0);
  });

  it("refuses a private IP literal and the name localhost", async () => {
    SERVER_ROW.current = row({ relayUrl: `http://127.0.0.1:${relayUrlBase}` });
    await expect(relayRequest({ serverId: "srv-owned", path: "/health" })).rejects.toMatchObject({ code: "ECONNDENIED" });
    SERVER_ROW.current = row({ relayUrl: `http://localhost:${relayUrlBase}` });
    await expect(relayRequest({ serverId: "srv-owned", path: "/health" })).rejects.toMatchObject({ code: "ECONNDENIED" });
    SERVER_ROW.current = row({ relayUrl: `http://[::1]:${relayUrlBase}` });
    await expect(relayRequest({ serverId: "srv-owned", path: "/health" })).rejects.toMatchObject({ code: "ECONNDENIED" });
    expect(hits).toBe(0);
  });

  it("an unowned (admin-shared) row keeps connecting to a private target", async () => {
    SERVER_ROW.current = row({ userId: null, relayUrl: `http://127.0.0.1:${relayUrlBase}` });
    await expect(relayRequest({ serverId: "srv-owned", path: "/health" })).resolves.toEqual({ ok: true });
    expect(hits).toBe(1);
  });

  it("an admin actor on an owned row keeps connecting to a private target; a non-admin actor or none is refused", async () => {
    SERVER_ROW.current = row({ relayUrl: `http://127.0.0.1:${relayUrlBase}` });
    await expect(
      relayRequest({ serverId: "srv-owned", path: "/health", actor: { isAdmin: true } }),
    ).resolves.toEqual({ ok: true });
    expect(hits).toBe(1);
    await expect(
      relayRequest({ serverId: "srv-owned", path: "/health", actor: { isAdmin: false } }),
    ).rejects.toMatchObject({ code: "ECONNDENIED" });
    await expect(relayRequest({ serverId: "srv-owned", path: "/health" })).rejects.toMatchObject({ code: "ECONNDENIED" });
    expect(hits).toBe(1);
  });

  it("a row listed in TRUSTED_RELAY_SERVER_IDS keeps connecting to a name that resolves private, without any resolution by the guard", async () => {
    const stub = stubResolver([PRIVATE]);
    _setConnectResolver(stub.fn);
    SERVER_ROW.current = row({ id: "srv-trusted", relayUrl: `http://localhost:${relayUrlBase}` });
    await expect(relayRequest({ serverId: "srv-trusted", path: "/health" })).resolves.toEqual({ ok: true });
    expect(hits).toBe(1);
    expect(stub.calls).toEqual([]);
  });
});

describe("relayFetch option", () => {
  it("guarded refuses a private target, unguarded (admin) connects", async () => {
    await expect(
      relayFetch(`http://127.0.0.1:${relayUrlBase}/health`, {}, { guarded: true }),
    ).rejects.toMatchObject({ code: "ECONNDENIED" });
    expect(hits).toBe(0);
    const res = await relayFetch(`http://127.0.0.1:${relayUrlBase}/health`, {}, { guarded: false });
    expect(res.status).toBe(200);
    expect(hits).toBe(1);
  });
});

describe("streamDeploy", () => {
  const base = {
    serverId: "srv-owned",
    deployId: "d1",
    appId: "app-1",
    appName: "thd",
    relayToken: null,
    body: {},
  };

  it("with connectGuard it never reaches a relay on a private name and takes the connection-lost path", async () => {
    // `localhost` resolves on this machine, so only the guard keeps it from the listener
    await streamDeploy({ ...base, relayUrl: `http://localhost:${relayUrlBase}`, connectGuard: true });
    expect(hits).toBe(0);
    expect(recoverBrokenDeploy).toHaveBeenCalledTimes(1);
  });

  it("without connectGuard (admin-shared or listed row) the same private target is reached", async () => {
    await streamDeploy({ ...base, relayUrl: `http://127.0.0.1:${relayUrlBase}`, connectGuard: false });
    expect(hits).toBe(1);
  });
});

describe("executeSshCommand with guardTarget", () => {
  const ssh = (host: string, over: Record<string, unknown> = {}) =>
    executeSshCommand({
      host,
      port: tcpPort,
      user: "root",
      auth: { kind: "password", password: "x" },
      command: "true",
      timeoutMs: 3000,
      guardTarget: true,
      ...over,
    });

  it("refuses a name that flips from public to private before ssh2 connects", async () => {
    const stub = stubResolver([PUBLIC, PRIVATE]);
    _setConnectResolver(stub.fn);
    vi.spyOn(dns.promises, "lookup").mockImplementation((async (host: string) =>
      new Promise((resolve, reject) =>
        stub.fn(host, (err, a) => (err ? reject(err) : resolve(a))),
      )) as never);
    const check = await assertServerTargetsAllowed({ isAdmin: false }, { host: "ssh.flip.test" }, "srv-owned");
    expect(check).toEqual({ ok: true });

    await expect(ssh("ssh.flip.test")).rejects.toMatchObject({ name: "SshError", kind: "connect_failed" });
    expect(stub.calls).toHaveLength(2);
    expect(tcpConnections).toBe(0);
  });

  it("refuses on a lookup error and for private literals, with no connection", async () => {
    _setConnectResolver(stubResolver([Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })]).fn);
    await expect(ssh("ssh.down.test")).rejects.toBeInstanceOf(SshError);
    await expect(ssh("127.0.0.1")).rejects.toBeInstanceOf(SshError);
    await expect(ssh("::1")).rejects.toBeInstanceOf(SshError);
    await expect(ssh("localhost")).rejects.toBeInstanceOf(SshError);
    expect(tcpConnections).toBe(0);
  });

  it("without guardTarget (admin, unowned row, listed row) the same private host is dialed", async () => {
    await expect(ssh("127.0.0.1", { guardTarget: false })).rejects.toBeInstanceOf(SshError);
    expect(tcpConnections).toBe(1);
  });
});
