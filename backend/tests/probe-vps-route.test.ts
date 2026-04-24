import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: {
      findUnique: vi.fn(),
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

// Mock the SSH-facing probe so we can exercise the route layer without
// standing up a mock SSH server.
vi.mock("../src/services/probe-vps.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/probe-vps.js")>(
    "../src/services/probe-vps.js",
  );
  return {
    ...actual,
    probeVps: vi.fn(),
  };
});

import { probeVps } from "../src/services/probe-vps.js";
import { serversRouter } from "../src/routes/servers.js";
import { SshError } from "../src/services/ssh-executor.js";
import { Hono } from "hono";

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

const validBody = {
  host: "1.2.3.4",
  sshUser: "root",
  sshPort: 22,
  sshPassword: "hunter2",
};

const asJson = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("POST /servers/probe-vps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects non-admin with 403", async () => {
    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/probe-vps",
      asJson(validBody),
    );
    expect(res.status).toBe(403);
    expect(probeVps).not.toHaveBeenCalled();
  });

  it("rejects non-JSON body with 400", async () => {
    const res = await appFor({ userId: null, isAdmin: true }).request("/servers/probe-vps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
    expect(probeVps).not.toHaveBeenCalled();
  });

  it("rejects missing credentials with 400", async () => {
    const { sshPassword: _pw, ...bodyNoAuth } = validBody;
    void _pw;
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/probe-vps",
      asJson(bodyNoAuth),
    );
    expect(res.status).toBe(400);
    expect(probeVps).not.toHaveBeenCalled();
  });

  it("rejects when both password and privateKey are provided", async () => {
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/probe-vps",
      asJson({ ...validBody, sshPrivateKey: "-----BEGIN..." }),
    );
    expect(res.status).toBe(400);
  });

  it("maps SSH auth failure to 502 with kind=auth_failed", async () => {
    vi.mocked(probeVps).mockRejectedValue(new SshError("bad creds", "auth_failed"));
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/probe-vps",
      asJson(validBody),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("auth_failed");
  });

  it("maps timeout to kind=timeout", async () => {
    const err = new SshError("op timed out", "timeout");
    vi.mocked(probeVps).mockRejectedValue(err);
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/probe-vps",
      asJson(validBody),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("timeout");
  });

  it("returns 200 with probe + hostKeySha256 on success", async () => {
    vi.mocked(probeVps).mockResolvedValue({
      probe: {
        port80: { kind: "free" },
        port443: { kind: "free" },
        containers: [],
        networks: [],
        suggestedMode: "greenfield",
      },
      hostKeySha256: "abc123==",
    });
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/probe-vps",
      asJson(validBody),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      probe: { suggestedMode: string };
      hostKeySha256: string;
    };
    expect(body.probe.suggestedMode).toBe("greenfield");
    expect(body.hostKeySha256).toBe("abc123==");
  });

  it("omits hostKeySha256 from the response when the probe didn't capture one", async () => {
    vi.mocked(probeVps).mockResolvedValue({
      probe: {
        port80: { kind: "free" },
        port443: { kind: "free" },
        containers: [],
        networks: [],
        suggestedMode: "greenfield",
      },
      // hostKeySha256 omitted — probe didn't receive a key callback
    });
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/probe-vps",
      asJson(validBody),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect("hostKeySha256" in body).toBe(false);
  });
});
