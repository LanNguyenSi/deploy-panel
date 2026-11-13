// A relay that answers 3xx must never make the panel fetch the Location, and
// nothing from the redirect target may reach the caller. Real fetch against two
// local listeners: the "relay" (always 302 to the second listener) and the
// "internal" listener that stands for 169.254.169.254 or a loopback service.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    app: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    deploy: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
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
  },
  allowedGitHubLogins: [],
}));

vi.mock("../src/lib/ghcr.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/ghcr.js")>("../src/lib/ghcr.js");
  return { ...actual, getLatestRelayRevision: vi.fn().mockResolvedValue(null) };
});

vi.mock("../src/lib/provision-secrets.js", () => ({
  provisionAndCheckAppSecrets: vi.fn().mockResolvedValue({ provisionedKeys: [], wrote: false, missing: [] }),
}));

vi.mock("../src/lib/deploy-recovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/deploy-recovery.js")>();
  return { ...actual, recoverBrokenDeploy: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../src/services/ssh-executor.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/ssh-executor.js")>(
    "../src/services/ssh-executor.js",
  );
  return { ...actual, executeSshCommand: vi.fn() };
});

vi.mock("../src/lib/post-deploy-gate.js", () => ({ verifyDeployHealth: vi.fn() }));

import { prisma } from "../src/lib/prisma.js";
import { serversRouter } from "../src/routes/servers.js";
import { relayRequest, RelayError } from "../src/lib/relay.js";
import { fetchRelayHealth } from "../src/lib/ghcr.js";
import { readRelaySelfUpdateOutcome } from "../src/services/relay-self-update.js";
import { streamDeploy } from "../src/lib/stream-deploy.js";
import { recoverBrokenDeploy } from "../src/lib/deploy-recovery.js";
import { relayFetch, RELAY_REDIRECT_MESSAGE } from "../src/lib/relay-fetch.js";
import { executeSshCommand } from "../src/services/ssh-executor.js";
import { activeInstalls } from "../src/services/active-installs.js";

const mServer = prisma.server as unknown as { findUnique: ReturnType<typeof vi.fn> };
const mApp = prisma.app as unknown as { findUnique: ReturnType<typeof vi.fn> };

const SECRET = "internal-secret-body";

let relay: Server;
let internal: Server;
let relayUrl: string;
let internalHits: number;
let relayHits: number;

const listen = (s: Server) =>
  new Promise<number>((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
const close = (s: Server) => new Promise<void>((resolve) => s.close(() => resolve()));

beforeEach(async () => {
  vi.clearAllMocks();
  internalHits = 0;
  relayHits = 0;
  activeInstalls.clear();
  mApp.findUnique.mockResolvedValue({ requiredEnvKeys: [], liveUrl: null });
  internal = createServer((_req, res) => {
    internalHits += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ secret: SECRET, revision: "abc1234", state: null }));
  });
  const internalPort = await listen(internal);
  relay = createServer((_req, res) => {
    relayHits += 1;
    res.writeHead(302, { Location: `http://127.0.0.1:${internalPort}/latest/meta-data` });
    res.end("moved");
  });
  relayUrl = `http://127.0.0.1:${await listen(relay)}`;
  mServer.findUnique.mockResolvedValue({
    id: "srv-a",
    userId: null,
    name: "vps-a",
    host: "203.0.113.10",
    relayUrl,
    relayToken: "tok",
  });
});

afterEach(async () => {
  await close(relay);
  await close(internal);
});

function adminApp() {
  const app = new Hono<{ Variables: { userId?: string; isAdmin?: boolean } }>();
  app.use("/*", async (c, next) => {
    c.set("isAdmin", true);
    await next();
  });
  app.route("/servers", serversRouter as unknown as Hono<any>);
  return app;
}

describe("relay redirects are not followed", () => {
  it("relayFetch turns a 3xx into a fixed 502 and never requests the Location", async () => {
    const res = await relayFetch(`${relayUrl}/health`);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe(RELAY_REDIRECT_MESSAGE);
    expect(internalHits).toBe(0);
  });

  it("GET /servers/:id/system does not return the redirect target's body", async () => {
    const res = await adminApp().request("/servers/srv-a/system");
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(text).not.toContain(SECRET);
    expect(internalHits).toBe(0);
  });

  it("an admin-owned row is not exempt: its relay's 302 is the fixed 502, not the target's answer", async () => {
    // Admins are not filtered by the host guard, but redirects are refused
    // for every caller. A relayUrl that redirects must be set to its final URL.
    mServer.findUnique.mockResolvedValue({
      id: "srv-a",
      userId: null,
      name: "fleet-a",
      host: "203.0.113.10",
      relayUrl,
      relayToken: "tok",
    });
    const res = await adminApp().request("/servers/srv-a/system");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "relay_error", status: 502 });
    expect(internalHits).toBe(0);
  });

  it("POST /servers/:id/test does not return the redirect target's body", async () => {
    const res = await adminApp().request("/servers/srv-a/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text).status).not.toBe("online");
    expect(internalHits).toBe(0);
  });

  it("relayRequest raises a relay error instead of returning the redirect target's JSON", async () => {
    const err = await relayRequest({ serverId: "srv-a", path: "/api/apps/x/env" }).catch((e) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).status).toBe(502);
    expect((err as RelayError).message).not.toContain(SECRET);
    expect(internalHits).toBe(0);
  });

  it("fetchRelayHealth reports the relay as not online", async () => {
    const probe = await fetchRelayHealth({ relayUrl, relayToken: "tok" });
    expect(probe.online).toBe(false);
    expect(probe.data).toBeNull();
    expect(internalHits).toBe(0);
  });

  it("readRelaySelfUpdateOutcome ignores a redirecting relay", async () => {
    const outcome = await readRelaySelfUpdateOutcome({
      server: { relayUrl, relayToken: "tok" },
      previousRevision: null,
      targetRevision: null,
      mode: "timeout",
      notBefore: Date.now(),
    });
    expect(outcome).toEqual({ kind: "none" });
    expect(internalHits).toBe(0);
  });

  it("POST /servers/:id/relay-self-update does not follow a redirect on the trigger", async () => {
    const res = await adminApp().request("/servers/srv-a/relay-self-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const text = await res.text();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(text).not.toContain(SECRET);
    expect(relayHits).toBeGreaterThan(0);
    expect(internalHits).toBe(0);
  });

  it("POST /servers/:id/update-relay-image does not follow a redirect on the post-update health check", async () => {
    mServer.findUnique.mockResolvedValue({
      id: "srv-a",
      userId: null,
      name: "vps-a",
      host: "203.0.113.10",
      relayUrl,
      relayToken: "tok",
      relayDir: null,
      relayComposeFile: null,
      hostKeySha256: "fp".padEnd(44, "="),
    });
    vi.mocked(executeSshCommand).mockImplementation(async (opts) => {
      // The preflight grep finds no `build:`; the compose command succeeds.
      return { exitCode: opts.command.includes("grep -qE") ? 1 : 0, finished: true };
    });
    const res = await adminApp().request("/servers/srv-a/update-relay-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sshUser: "root", sshPort: 22, sshPassword: "hunter2" }),
    });
    // The health check retries after 0, 2 and 4 s; the first attempt is enough
    // to show whether the redirect was followed.
    const reader = res.body!.getReader();
    const deadline = Date.now() + 3000;
    while (relayHits === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 150));
    expect(relayHits).toBeGreaterThan(0);
    expect(internalHits).toBe(0);
    await reader.cancel().catch(() => undefined);
  });

  it("streamDeploy treats a 3xx as a lost relay and does not request the Location", async () => {
    await streamDeploy({
      serverId: "srv-a",
      deployId: "d1",
      appId: "app-1",
      appName: "my-app",
      relayUrl,
      relayToken: null,
      body: {},
      timeouts: { idleMs: 500, firstByteMs: 500 },
    });
    expect(internalHits).toBe(0);
    expect(recoverBrokenDeploy).toHaveBeenCalledTimes(1);
  });
});
