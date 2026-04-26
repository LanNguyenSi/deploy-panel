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

// The route now issues TWO SSH calls in the happy path:
//   1. Preflight grep that detects `build:`-based compose files. Returns
//      exit 1 in this helper (no `build:` present → proceed).
//   2. The docker compose pull/up command, which honours the `exitCode`
//      kwarg below.
// Tests that exercise the preflight-trips branch use mockSshBuildBased
// instead. Both helpers fire the optional onHostKey on the FIRST call so
// fingerprint capture has the same shape as before this preflight landed.
function mockSshOk({ exitCode = 0, hostKeySha256 }: { exitCode?: number; hostKeySha256?: string } = {}) {
  let callCount = 0;
  vi.mocked(executeSshCommand).mockImplementation(async (opts) => {
    callCount += 1;
    if (callCount === 1 && hostKeySha256 && opts.onHostKey) {
      opts.onHostKey({ algo: "ssh-host-key", sha256: hostKeySha256 });
    }
    // The preflight grep is the first call; report "no match" so the
    // route proceeds to the docker step.
    if (opts.command.includes("grep -qE")) {
      return { exitCode: 1, finished: true };
    }
    // Fire a representative stdout line so forwardProgress doesn't
    // starve; the route doesn't parse stdout for this flow.
    opts.onStdout?.("relay Pulling");
    opts.onStdout?.("relay Pulled");
    return { exitCode, finished: true };
  });
}

// Helper for tests that exercise the `build:`-based-compose branch:
// preflight grep returns 0 (match found), and the route MUST NOT reach
// the docker call. If it does, the second mock invocation throws so the
// test fails loudly rather than silently masking the regression.
function mockSshBuildBased({ hostKeySha256 }: { hostKeySha256?: string } = {}) {
  let callCount = 0;
  vi.mocked(executeSshCommand).mockImplementation(async (opts) => {
    callCount += 1;
    if (callCount === 1 && hostKeySha256 && opts.onHostKey) {
      opts.onHostKey({ algo: "ssh-host-key", sha256: hostKeySha256 });
    }
    if (opts.command.includes("grep -qE")) {
      return { exitCode: 0, finished: true };
    }
    throw new Error(
      "docker compose call must not run when preflight detects `build:`-based compose",
    );
  });
}

// Find the docker-compose call regardless of how many SSH calls came
// before it. Existing tests that asserted on `mock.calls[0]?.[0]` were
// indexing the (now first) preflight grep — switch to a content-based
// lookup so the assertion stays anchored to what it actually cares about.
function dockerCall(): { command: string; expectedHostKeySha256?: string } | undefined {
  return vi
    .mocked(executeSshCommand)
    .mock.calls.find((c) => c[0].command.includes("docker compose"))?.[0];
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
    const sshCall = dockerCall();
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
    const sshCall = dockerCall();
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

  it("body-supplied relayDir overrides stored value and templates into the cd command", async () => {
    mServer.findUnique.mockResolvedValue(serverFixture({ relayDir: "/opt/agent-relay" }));
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/update-relay-image",
      asJson({ ...validBody, relayDir: "/root/git/agent-relay" }),
    );
    expect(res.status).toBe(200);
    await readSse(res);
    const sshCall = dockerCall();
    expect(sshCall?.command).toContain("cd /root/git/agent-relay");
    expect(sshCall?.command).not.toContain("cd /opt/agent-relay");
  });

  it("falls back to stored relayDir when body omits it", async () => {
    mServer.findUnique.mockResolvedValue(serverFixture({ relayDir: "/custom/path" }));
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/update-relay-image",
      asJson(validBody),
    );
    await readSse(res);
    const sshCall = dockerCall();
    expect(sshCall?.command).toContain("cd /custom/path");
  });

  it("defaults to /opt/agent-relay when neither body nor DB specifies one (legacy row)", async () => {
    mServer.findUnique.mockResolvedValue(serverFixture({ relayDir: null }));
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/update-relay-image",
      asJson(validBody),
    );
    await readSse(res);
    const sshCall = dockerCall();
    expect(sshCall?.command).toContain("cd /opt/agent-relay");
  });

  it("persists a backfilled relayDir on success", async () => {
    mServer.findUnique.mockResolvedValue(serverFixture({ relayDir: null }));
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/update-relay-image",
      asJson({ ...validBody, relayDir: "/root/git/agent-relay" }),
    );
    await readSse(res);
    const updateCalls = vi.mocked(prisma.server.update).mock.calls;
    const relayDirUpdate = updateCalls.find((c) => c[0].data.relayDir);
    expect(relayDirUpdate?.[0].data.relayDir).toBe("/root/git/agent-relay");
  });

  it("templates `-f <compose-file>` into both docker compose invocations when set", async () => {
    mServer.findUnique.mockResolvedValue(
      serverFixture({
        relayDir: "/root/git/agent-relay",
        relayComposeFile: "docker-compose.prod.yml",
      }),
    );
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/update-relay-image",
      asJson(validBody),
    );
    await readSse(res);
    const sshCall = dockerCall();
    // Both pull and up -d must get -f so docker doesn't recreate the
    // container via the dev docker-compose.yml (which would strip
    // Traefik labels and swap the bind mount).
    expect(sshCall?.command).toContain("docker compose -f docker-compose.prod.yml pull");
    expect(sshCall?.command).toContain("docker compose -f docker-compose.prod.yml up -d");
  });

  it("omits -f when no compose file is stored or supplied (installer default)", async () => {
    mServer.findUnique.mockResolvedValue(serverFixture({ relayComposeFile: null }));
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/update-relay-image",
      asJson(validBody),
    );
    await readSse(res);
    const sshCall = dockerCall();
    expect(sshCall?.command).not.toContain("-f ");
    expect(sshCall?.command).toContain("docker compose pull");
  });

  it("body-supplied relayComposeFile overrides stored value and persists", async () => {
    mServer.findUnique.mockResolvedValue(
      serverFixture({ relayComposeFile: "docker-compose.yml" }),
    );
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/update-relay-image",
      asJson({ ...validBody, relayComposeFile: "docker-compose.prod.yml" }),
    );
    await readSse(res);
    const sshCall = dockerCall();
    expect(sshCall?.command).toContain("-f docker-compose.prod.yml");
    const updateCalls = vi.mocked(prisma.server.update).mock.calls;
    const composeUpdate = updateCalls.find((c) => c[0].data.relayComposeFile);
    expect(composeUpdate?.[0].data.relayComposeFile).toBe("docker-compose.prod.yml");
  });

  it("rejects relayComposeFile with path separators (must be basename only)", async () => {
    mServer.findUnique.mockResolvedValue(serverFixture());
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/update-relay-image",
      asJson({ ...validBody, relayComposeFile: "../etc/passwd" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects relayComposeFile without .yml extension", async () => {
    mServer.findUnique.mockResolvedValue(serverFixture());
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/update-relay-image",
      asJson({ ...validBody, relayComposeFile: "compose.txt" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a body-supplied relayDir with shell metachars", async () => {
    mServer.findUnique.mockResolvedValue(serverFixture());
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/srv-a/update-relay-image",
      asJson({ ...validBody, relayDir: "/opt/agent-relay; rm -rf /" }),
    );
    expect(res.status).toBe(400);
  });

  // NOTE: Cross-lock tests (in-flight reinstall blocks update, actor-
  // lock blocks parallel updates) are hard to exercise in this harness
  // because `activeInstalls` is a module-private Set and the streamSSE
  // handler's timing is non-deterministic across tests. They are
  // covered behaviorally by the 429 branch being reachable from the
  // same keys the reinstall route sets — symmetric cross-lock sourced
  // in the same reviewed commit. Flag as a follow-up test harness
  // improvement if future regressions sneak through.

  describe("compose-file preflight", () => {
    it("issues a grep preflight before the docker call", async () => {
      mServer.findUnique.mockResolvedValue(serverFixture());
      const res = await appFor({ userId: null, isAdmin: true }).request(
        "/servers/srv-a/update-relay-image",
        asJson(validBody),
      );
      await readSse(res);
      const calls = vi.mocked(executeSshCommand).mock.calls;
      // First call must be the preflight; second must be docker. Order
      // matters because the preflight short-circuits before any docker
      // mutation happens.
      expect(calls[0]?.[0].command).toContain("grep -qE");
      expect(calls[0]?.[0].command).toContain("build:");
      expect(calls[1]?.[0].command).toContain("docker compose");
    });

    it("returns compose_is_build_based and skips docker when the compose file uses `build:`", async () => {
      mServer.findUnique.mockResolvedValue(serverFixture());
      mockSshBuildBased();
      const res = await appFor({ userId: null, isAdmin: true }).request(
        "/servers/srv-a/update-relay-image",
        asJson(validBody),
      );
      const events = await readSse(res);
      const err = events.find((e) => e.event === "error");
      expect(err?.data.kind).toBe("compose_is_build_based");
      // Message must name the failure mode AND give the operator both
      // recovery paths (edit compose file OR re-install). Asserting on
      // these keywords keeps the contract greppable from the route.
      expect(err?.data.message).toContain("build:");
      expect(err?.data.message).toContain("image:");
      expect(err?.data.message).toContain("Re-install Relay");
      // No docker call must have run — mockSshBuildBased throws if it
      // does, so reaching this assertion at all is half the proof; we
      // also verify directly that no `docker compose` ever shipped.
      const dockerInvoked = vi
        .mocked(executeSshCommand)
        .mock.calls.some((c) => c[0].command.includes("docker compose"));
      expect(dockerInvoked).toBe(false);
    });

    it("templates the configured compose file into the grep target", async () => {
      mServer.findUnique.mockResolvedValue(
        serverFixture({
          relayDir: "/root/git/agent-relay",
          relayComposeFile: "docker-compose.prod.yml",
        }),
      );
      const res = await appFor({ userId: null, isAdmin: true }).request(
        "/servers/srv-a/update-relay-image",
        asJson(validBody),
      );
      await readSse(res);
      const preflight = vi
        .mocked(executeSshCommand)
        .mock.calls.find((c) => c[0].command.includes("grep -qE"))?.[0];
      // Without templating the override in, the preflight would inspect
      // a different compose file from the one docker actually uses —
      // and the build/image classification could disagree.
      expect(preflight?.command).toContain("docker-compose.prod.yml");
      expect(preflight?.command).toContain("cd /root/git/agent-relay");
    });

    it("falls back to docker-compose.yml for the preflight when no compose file is set", async () => {
      mServer.findUnique.mockResolvedValue(serverFixture({ relayComposeFile: null }));
      const res = await appFor({ userId: null, isAdmin: true }).request(
        "/servers/srv-a/update-relay-image",
        asJson(validBody),
      );
      await readSse(res);
      const preflight = vi
        .mocked(executeSshCommand)
        .mock.calls.find((c) => c[0].command.includes("grep -qE"))?.[0];
      // Matches the docker-compose default — same file the docker step
      // would implicitly target without `-f`.
      expect(preflight?.command).toContain("docker-compose.yml");
    });

    it("captures and persists the host-key fingerprint on the build-based early-return path (legacy row)", async () => {
      mServer.findUnique.mockResolvedValue(serverFixture({ hostKeySha256: null }));
      mockSshBuildBased({ hostKeySha256: "preflight-fp==".padEnd(44, "=") });
      const res = await appFor({ userId: null, isAdmin: true }).request(
        "/servers/srv-a/update-relay-image",
        asJson(validBody),
      );
      await readSse(res);
      // The early-return MUST NOT throw away a fresh fingerprint — the
      // operator already authenticated, so the next legitimate update
      // shouldn't re-TOFU just because the preflight tripped.
      const updateCalls = vi.mocked(prisma.server.update).mock.calls;
      const fingerprintCall = updateCalls.find((c) => c[0].data.hostKeySha256);
      expect(fingerprintCall?.[0].data.hostKeySha256).toBe(
        "preflight-fp==".padEnd(44, "="),
      );
    });

    it("does not persist the fingerprint twice when both preflight and docker fire onHostKey", async () => {
      // Defense-in-depth path: helper guards against duplicate writes.
      mServer.findUnique.mockResolvedValue(serverFixture({ hostKeySha256: null }));
      vi.mocked(executeSshCommand).mockImplementation(async (opts) => {
        // Both calls fire onHostKey with the same fingerprint.
        opts.onHostKey?.({ algo: "ssh-host-key", sha256: "dup==".padEnd(44, "=") });
        if (opts.command.includes("grep -qE")) {
          return { exitCode: 1, finished: true };
        }
        return { exitCode: 0, finished: true };
      });
      const res = await appFor({ userId: null, isAdmin: true }).request(
        "/servers/srv-a/update-relay-image",
        asJson(validBody),
      );
      await readSse(res);
      const fingerprintWrites = vi
        .mocked(prisma.server.update)
        .mock.calls.filter((c) => c[0].data.hostKeySha256);
      expect(fingerprintWrites.length).toBe(1);
    });
  });
});
