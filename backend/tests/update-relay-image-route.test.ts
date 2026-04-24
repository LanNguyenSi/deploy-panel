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

vi.mock("../src/services/ssh-executor.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/services/ssh-executor.js")
  >("../src/services/ssh-executor.js");
  return {
    ...actual,
    executeSshCommand: vi.fn(),
  };
});

import { prisma } from "../src/lib/prisma.js";
import { serversRouter } from "../src/routes/servers.js";
import { executeSshCommand, SshError } from "../src/services/ssh-executor.js";
import { Hono } from "hono";

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

function mockSshOk({ exitCode = 0, hostKeySha256 }: { exitCode?: number; hostKeySha256?: string } = {}) {
  vi.mocked(executeSshCommand).mockImplementation(async (opts) => {
    if (hostKeySha256 && opts.onHostKey) {
      opts.onHostKey({ algo: "ssh-host-key", sha256: hostKeySha256 });
    }
    // Fire a representative stdout line so forwardProgress doesn't
    // starve; the route doesn't parse stdout for this flow.
    opts.onStdout?.("relay Pulling");
    opts.onStdout?.("relay Pulled");
    return { exitCode, finished: true };
  });
}

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
        /* ignore */
      }
    }
  }
  return events;
}

const serverFixture = (overrides: Record<string, unknown> = {}) => ({
  id: "srv-a",
  userId: null,
  name: "a",
  host: "a.example",
  relayUrl: "http://a.example:8222",
  relayToken: "tok",
  hostKeySha256: "fp==".padEnd(44, "="),
  relayMode: "port-only",
  status: "online",
  sshKeyPath: null,
  lastSeenAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe("POST /servers/:id/update-relay-image", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The route's post-update /health probe retries up to 3 times with
    // 0 + 2s + 4s back-off on failure — that's 6s, longer than vitest's
    // default 5s timeout. Stub `fetch` to resolve OK immediately so
    // only the first probe runs; the actual health-check behavior has
    // its own coverage via the existing /:id/test route tests.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    mockSshOk();
  });

  it("returns 404 when the server does not exist", async () => {
    mServer.findUnique.mockResolvedValue(null);
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/does-not-exist/update-relay-image",
      asJson(validBody),
    );
    expect(res.status).toBe(404);
    expect(executeSshCommand).not.toHaveBeenCalled();
  });

  it("returns 404 (not 403) when a non-admin tries to update someone else's server", async () => {
    mServer.findUnique.mockResolvedValue(serverFixture({ id: "srv-b", userId: "user-b" }));
    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/srv-b/update-relay-image",
      asJson(validBody),
    );
    expect(res.status).toBe(404);
  });

  it("rejects missing credentials with 400", async () => {
    mServer.findUnique.mockResolvedValue(serverFixture());
    const { sshPassword: _pw, ...bodyNoAuth } = validBody;
    void _pw;
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/update-relay-image",
      asJson(bodyNoAuth),
    );
    expect(res.status).toBe(400);
  });

  it("sends a compose pull + up -d command, not install.sh", async () => {
    mServer.findUnique.mockResolvedValue(serverFixture());
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/update-relay-image",
      asJson(validBody),
    );
    expect(res.status).toBe(200);
    await readSse(res);
    const sshCall = vi.mocked(executeSshCommand).mock.calls[0]?.[0];
    expect(sshCall?.command).toMatch(/docker compose pull/);
    expect(sshCall?.command).toMatch(/docker compose up -d/);
    expect(sshCall?.command).not.toMatch(/install\.sh/);
    expect(sshCall?.command).not.toMatch(/curl -sSL/);
  });

  it("pins the stored host-key fingerprint against the SSH handshake", async () => {
    mServer.findUnique.mockResolvedValue(serverFixture({ hostKeySha256: "pinned-fp-val==".padEnd(44, "=") }));
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/update-relay-image",
      asJson(validBody),
    );
    await readSse(res);
    const sshCall = vi.mocked(executeSshCommand).mock.calls[0]?.[0];
    expect(sshCall?.expectedHostKeySha256).toBe("pinned-fp-val==".padEnd(44, "="));
  });

  it("captures the fingerprint on a legacy row and persists it via a dedicated update", async () => {
    mServer.findUnique.mockResolvedValue(serverFixture({ hostKeySha256: null }));
    mockSshOk({ hostKeySha256: "fresh-capture==".padEnd(44, "=") });
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/update-relay-image",
      asJson(validBody),
    );
    await readSse(res);
    const updateCalls = vi.mocked(prisma.server.update).mock.calls;
    const fingerprintCall = updateCalls.find((c) => c[0].data.hostKeySha256);
    expect(fingerprintCall).toBeDefined();
    expect(fingerprintCall?.[0].data.hostKeySha256).toBe("fresh-capture==".padEnd(44, "="));
  });

  it("surfaces docker compose failure as error SSE frame", async () => {
    mServer.findUnique.mockResolvedValue(serverFixture());
    mockSshOk({ exitCode: 1 });
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/update-relay-image",
      asJson(validBody),
    );
    const events = await readSse(res);
    const err = events.find((e) => e.event === "error");
    expect(err?.data.kind).toBe("update_failed");
    expect(err?.data.message).toContain("docker compose");
  });

  it("maps host_key_rejected to a clear error frame", async () => {
    mServer.findUnique.mockResolvedValue(serverFixture());
    vi.mocked(executeSshCommand).mockRejectedValue(
      new SshError("host key differs", "host_key_rejected"),
    );
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/update-relay-image",
      asJson(validBody),
    );
    const events = await readSse(res);
    const err = events.find((e) => e.event === "error");
    expect(err?.data.kind).toBe("host_key_rejected");
    expect(err?.data.message).toMatch(/VPS rebuilt/);
  });

  it("does not touch relayMode / relayToken / relayUrl on success (non-install semantics)", async () => {
    mServer.findUnique.mockResolvedValue(serverFixture());
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/update-relay-image",
      asJson(validBody),
    );
    await readSse(res);
    // Find the post-SSH update (there's at most one when hostKeySha256
    // was already set — that update touches only lastSeenAt/status).
    const postUpdateCall = vi.mocked(prisma.server.update).mock.calls[0]?.[0];
    expect(postUpdateCall?.data.relayMode).toBeUndefined();
    expect(postUpdateCall?.data.relayToken).toBeUndefined();
    expect(postUpdateCall?.data.relayUrl).toBeUndefined();
    expect(postUpdateCall?.data.lastSeenAt).toBeInstanceOf(Date);
  });

  it("emits healthOk: true on the done event when the post-update /health probe returns 200", async () => {
    // The beforeEach already stubs fetch to resolve 200 OK, so the
    // route's first probe should succeed and flip status → online.
    mServer.findUnique.mockResolvedValue(serverFixture());
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/update-relay-image",
      asJson(validBody),
    );
    const events = await readSse(res);
    const done = events.find((e) => e.event === "done");
    expect(done?.data.healthOk).toBe(true);
    // Status should also land online in the persisted update.
    const updateCall = vi.mocked(prisma.server.update).mock.calls[0]?.[0];
    expect(updateCall?.data.status).toBe("online");
  });

  it("persists fingerprint even when `docker compose` fails (compose failure mustn't throw away capture)", async () => {
    // Legacy row + SSH handshake succeeds + fingerprint captured, but
    // compose exits non-zero. The B2-style invariant from re-install
    // also applies here: the fingerprint was observed, persist it
    // before the compose-exit check so the next update doesn't
    // re-TOFU.
    mServer.findUnique.mockResolvedValue(serverFixture({ hostKeySha256: null }));
    mockSshOk({ exitCode: 1, hostKeySha256: "post-failure-fp==".padEnd(44, "=") });
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/update-relay-image",
      asJson(validBody),
    );
    const events = await readSse(res);
    expect(events.find((e) => e.event === "error")?.data.kind).toBe("update_failed");
    // Even though compose failed, the fingerprint was persisted via the
    // dedicated pre-exit-check update.
    const updateCalls = vi.mocked(prisma.server.update).mock.calls;
    const fingerprintCall = updateCalls.find((c) => c[0].data.hostKeySha256);
    expect(fingerprintCall?.[0].data.hostKeySha256).toBe(
      "post-failure-fp==".padEnd(44, "="),
    );
  });

  // NOTE: Cross-lock tests (in-flight reinstall blocks update, actor-
  // lock blocks parallel updates) are hard to exercise in this harness
  // because `activeInstalls` is a module-private Set and the streamSSE
  // handler's timing is non-deterministic across tests. They are
  // covered behaviorally by the 429 branch being reachable from the
  // same keys the reinstall route sets — symmetric cross-lock sourced
  // in the same reviewed commit. Flag as a follow-up test harness
  // improvement if future regressions sneak through.
});
