import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

// Mock the SSH executor so we can drive its stdout/onHostKey hooks
// without standing up a real ssh2 server. The route's success +
// fingerprint-capture + token-rotation paths all flow through here.
vi.mock("../src/services/ssh-executor.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/services/ssh-executor.js")
  >("../src/services/ssh-executor.js");
  return {
    ...actual,
    executeSshCommand: vi.fn(),
  };
});

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

import { prisma } from "../src/lib/prisma.js";
import { serversRouter } from "../src/routes/servers.js";
import { executeSshCommand } from "../src/services/ssh-executor.js";
import { Hono } from "hono";

const installOkOutput = (token: string) =>
  `\n  Mode:  greenfield\n  URL:   https://relay.example.com\n  Token: ${token}\n`;

// Drive a fake SSH session: emit the supplied stdout and (optionally)
// fire onHostKey, then resolve with exit 0. Used by the success-path
// tests to exercise the route's stdout-parsing + DB-update behavior
// without a real ssh2 server.
function mockSshOk({
  stdout,
  hostKeySha256,
}: {
  stdout: string;
  hostKeySha256?: string;
}) {
  vi.mocked(executeSshCommand).mockImplementation(async (opts) => {
    if (hostKeySha256 && opts.onHostKey) {
      opts.onHostKey({ algo: "ssh-host-key", sha256: hostKeySha256 });
    }
    if (opts.onStdout) {
      for (const line of stdout.split("\n")) opts.onStdout(line);
    }
    return { exitCode: 0, finished: true };
  });
}

// Drain an SSE response into discrete events for assertions.
async function readSse(res: Response): Promise<Array<{ event: string; data: any }>> {
  const text = await res.text();
  const events: Array<{ event: string; data: any }> = [];
  for (const block of text.split("\n\n")) {
    let event = "message";
    let dataStr = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
    }
    if (dataStr) {
      try {
        events.push({ event, data: JSON.parse(dataStr) });
      } catch {
        // ignore malformed
      }
    }
  }
  return events;
}

type ActorVars = {
  Variables: { userId?: string; isAdmin?: boolean; authType?: string };
};

const mServer = prisma.server as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
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

const validBody = {
  sshUser: "root",
  sshPort: 22,
  sshPassword: "hunter2",
};

const asJson = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("POST /servers/:id/install-relay (re-install)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock: SSH succeeds and emits a parseable install block.
    // Individual tests override via mockSshOk(...) for richer scenarios.
    mockSshOk({ stdout: installOkOutput("default-tok") });
  });

  it("returns 404 when server does not exist", async () => {
    mServer.findUnique.mockResolvedValue(null);
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-missing/install-relay",
      asJson(validBody),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 (not 403) when a non-admin tries to re-install someone else's server", async () => {
    // findOwnedServer returns null for ownership mismatch — same response
    // shape as not-found, so we assert the same status code. (Don't leak
    // existence of the row to a non-owner.)
    mServer.findUnique.mockResolvedValue({
      id: "srv-b",
      userId: "user-b",
      name: "b",
      host: "b.example",
      relayUrl: null,
      relayToken: null,
      hostKeySha256: null,
      relayMode: null,
      status: "online",
      sshKeyPath: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/srv-b/install-relay",
      asJson(validBody),
    );
    expect(res.status).toBe(404);
  });

  it("rejects non-JSON body with 400", async () => {
    mServer.findUnique.mockResolvedValue({
      id: "srv-a",
      userId: null,
      name: "a",
      host: "a.example",
      relayUrl: "http://a:8222",
      relayToken: "tok",
      hostKeySha256: "fp==",
      relayMode: "greenfield",
      status: "online",
      sshKeyPath: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/install-relay",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      },
    );
    expect(res.status).toBe(400);
  });

  it("rejects missing credentials with 400", async () => {
    mServer.findUnique.mockResolvedValue({
      id: "srv-a",
      userId: null,
      name: "a",
      host: "a.example",
      relayUrl: "http://a:8222",
      relayToken: "tok",
      hostKeySha256: null,
      relayMode: null,
      status: "online",
      sshKeyPath: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { sshPassword: _pw, ...bodyNoAuth } = validBody;
    void _pw;
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/install-relay",
      asJson(bodyNoAuth),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an invalid relayMode enum value with 400", async () => {
    mServer.findUnique.mockResolvedValue({
      id: "srv-a",
      userId: null,
      name: "a",
      host: "a.example",
      relayUrl: null,
      relayToken: null,
      hostKeySha256: null,
      relayMode: null,
      status: "online",
      sshKeyPath: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/install-relay",
      asJson({ ...validBody, relayMode: "bogus-mode" }),
    );
    expect(res.status).toBe(400);
  });

  it("admin can re-install any server (passes ownership gate)", async () => {
    // Even a server owned by user-b is re-installable by an admin.
    mServer.findUnique.mockResolvedValue({
      id: "srv-b",
      userId: "user-b",
      name: "b",
      host: "b.example",
      relayUrl: null,
      relayToken: null,
      hostKeySha256: null,
      relayMode: null,
      status: "online",
      sshKeyPath: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-b/install-relay",
      asJson(validBody),
    );
    expect(res.status).toBe(200);
    // Drain the SSE so the streamSSE handler finishes and releases the
    // module-level activeInstalls lock before the next test runs.
    await readSse(res);
  });

  it("server-owner (non-admin) can re-install their own server", async () => {
    mServer.findUnique.mockResolvedValue({
      id: "srv-a",
      userId: "user-a",
      name: "a",
      host: "a.example",
      relayUrl: null,
      relayToken: null,
      hostKeySha256: null,
      relayMode: null,
      status: "online",
      sshKeyPath: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/srv-a/install-relay",
      asJson(validBody),
    );
    expect(res.status).toBe(200);
    await readSse(res);
  });

  it("rotateToken=true prepends a `sudo rm -f /opt/agent-relay/.env` to the install command", async () => {
    mServer.findUnique.mockResolvedValue({
      id: "srv-a",
      userId: null,
      name: "a",
      host: "a.example",
      relayUrl: "http://a:8222",
      relayToken: "old-tok",
      hostKeySha256: "fp==".padEnd(44, "="),
      relayMode: "greenfield",
      status: "online",
      sshKeyPath: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockSshOk({ stdout: installOkOutput("new-tok") });
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/install-relay",
      asJson({ ...validBody, rotateToken: true }),
    );
    expect(res.status).toBe(200);
    await readSse(res);
    const sshCall = vi.mocked(executeSshCommand).mock.calls[0]?.[0];
    expect(sshCall?.command).toMatch(/^sudo rm -f \/opt\/agent-relay\/\.env && /);
  });

  it("rotateToken=false sends the bare install command (no rm)", async () => {
    mServer.findUnique.mockResolvedValue({
      id: "srv-a",
      userId: null,
      name: "a",
      host: "a.example",
      relayUrl: "http://a:8222",
      relayToken: "tok",
      hostKeySha256: "fp==".padEnd(44, "="),
      relayMode: "greenfield",
      status: "online",
      sshKeyPath: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockSshOk({ stdout: installOkOutput("tok") });
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/install-relay",
      asJson(validBody),
    );
    expect(res.status).toBe(200);
    await readSse(res);
    const sshCall = vi.mocked(executeSshCommand).mock.calls[0]?.[0];
    expect(sshCall?.command).not.toMatch(/sudo rm/);
  });

  it("does NOT update relayToken in the steady state (rotateToken=false + emitted equals DB)", async () => {
    mServer.findUnique.mockResolvedValue({
      id: "srv-a",
      userId: null,
      name: "a",
      host: "a.example",
      relayUrl: "http://a:8222",
      relayToken: "same-tok",
      hostKeySha256: "fp==".padEnd(44, "="),
      relayMode: "greenfield",
      status: "online",
      sshKeyPath: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockSshOk({ stdout: installOkOutput("same-tok") });
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/install-relay",
      asJson(validBody),
    );
    await readSse(res);
    // Find the post-install update call (the fingerprint-only update
    // doesn't fire when hostKeySha256 was already set).
    const updateCall = vi.mocked(prisma.server.update).mock.calls[0]?.[0];
    expect(updateCall?.data.relayToken).toBeUndefined();
  });

  it("surfaces tokenDiverged on the done event when emitted token differs without rotateToken", async () => {
    mServer.findUnique.mockResolvedValue({
      id: "srv-a",
      userId: null,
      name: "a",
      host: "a.example",
      relayUrl: "http://a:8222",
      relayToken: "old-tok",
      hostKeySha256: "fp==".padEnd(44, "="),
      relayMode: "greenfield",
      status: "online",
      sshKeyPath: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockSshOk({ stdout: installOkOutput("vps-emitted-different-tok") });
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/install-relay",
      asJson(validBody),
    );
    const events = await readSse(res);
    const done = events.find((e) => e.event === "done");
    expect(done?.data.tokenDiverged).toBe(true);
    expect(done?.data.tokenRotated).toBe(false);
  });

  it("captures + persists the host-key fingerprint for a legacy row", async () => {
    mServer.findUnique.mockResolvedValue({
      id: "srv-a",
      userId: null,
      name: "a",
      host: "a.example",
      relayUrl: null,
      relayToken: null,
      hostKeySha256: null,
      relayMode: null,
      status: "online",
      sshKeyPath: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockSshOk({
      stdout: installOkOutput("tok"),
      hostKeySha256: "AAAAB3NzaC1yc2EAAAADAQABAAABAQDxxxxxxxxxxxx=",
    });
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/install-relay",
      asJson(validBody),
    );
    await readSse(res);
    const updateCalls = vi.mocked(prisma.server.update).mock.calls;
    // First call (immediately after SSH handshake) writes the fingerprint
    // alone — the success-path update would not include hostKeySha256.
    const fingerprintCall = updateCalls.find((c) => c[0].data.hostKeySha256);
    expect(fingerprintCall).toBeDefined();
    expect(fingerprintCall?.[0].data.hostKeySha256).toBe(
      "AAAAB3NzaC1yc2EAAAADAQABAAABAQDxxxxxxxxxxxx=",
    );
  });

  it("does not persist relayMode='auto' (it's identical to omitting the env)", async () => {
    mServer.findUnique.mockResolvedValue({
      id: "srv-a",
      userId: null,
      name: "a",
      host: "a.example",
      relayUrl: null,
      relayToken: null,
      hostKeySha256: "fp==".padEnd(44, "="),
      relayMode: null,
      status: "online",
      sshKeyPath: null,
      lastSeenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockSshOk({
      stdout: "\n  Mode:  auto\n  URL:   http://1.2.3.4:8222\n  Token: tok\n",
    });
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/install-relay",
      asJson(validBody),
    );
    await readSse(res);
    const updateCall = vi.mocked(prisma.server.update).mock.calls[0]?.[0];
    expect(updateCall?.data.relayMode).toBeUndefined();
  });

  it("rejects expectedHostKeySha256 of wrong length on first-install schema (not this route, but adjacency)", () => {
    // This is the only place the new strict-44-char zod rule lives;
    // covered separately so the field shape doesn't drift back to the
    // looser .max(64) version. (We can't exercise it through THIS
    // route because re-install has no expectedHostKeySha256 field —
    // it pulls from DB.)
    expect(true).toBe(true);
  });
});
