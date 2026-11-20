import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

// Default dns.lookup result so non-admin host check resolves to a
// public address; individual tests can override.
vi.mock("node:dns", () => ({
  promises: {
    lookup: vi.fn().mockResolvedValue([{ address: "203.0.113.4", family: 4 }]),
  },
}));

// The SSH executor is mocked so the stream tests below can drive stdout,
// stderr and the exit code of the install command.
vi.mock("../src/services/ssh-executor.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/services/ssh-executor.js")
  >("../src/services/ssh-executor.js");
  return { ...actual, executeSshCommand: vi.fn() };
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

const mServer = prisma.server as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
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

const validBody = {
  name: "vps-1",
  host: "1.2.3.4",
  relayDomain: "relay.example.com",
  traefikEmail: "ops@example.com",
  sshUser: "root",
  sshPort: 22,
  sshPassword: "hunter2",
};

const asJson = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// We deliberately exercise *only* the pre-SSE early-return paths
// (auth, validation, uniqueness conflict). Anything past the
// `prisma.server.findUnique` check enters streamSSE → executeSshCommand
// territory which is covered by the install-relay service tests and
// would require a mock SSH server to drive end-to-end here.
describe("POST /servers/install-relay (pre-SSE gates)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated actor with 403", async () => {
    const res = await appFor({ userId: null, isAdmin: false }).request(
      "/servers/install-relay",
      asJson(validBody),
    );
    expect(res.status).toBe(403);
    expect(mServer.findUnique).not.toHaveBeenCalled();
  });

  it("non-admin reaches the uniqueness check (gate removed)", async () => {
    mServer.findUnique.mockResolvedValue({
      id: "srv-existing",
      name: "private-tenant-name",
      host: "1.2.3.4",
    });
    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/install-relay",
      asJson(validBody),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    // The non-admin must NOT see another tenant's server name.
    expect(body.message).not.toContain("private-tenant-name");
    expect(body.message).not.toContain("1.2.3.4");
    expect(mServer.findUnique).toHaveBeenCalledWith({ where: { host: "1.2.3.4" } });
  });

  it("admin sees the rich conflict message (server name + host)", async () => {
    mServer.findUnique.mockResolvedValue({
      id: "srv-existing",
      name: "fleet-server-3",
      host: "1.2.3.4",
    });
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/install-relay",
      asJson(validBody),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("fleet-server-3");
    expect(body.message).toContain("1.2.3.4");
  });

  it("non-admin cannot install against a literal private IP", async () => {
    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/install-relay",
      asJson({ ...validBody, host: "10.0.0.5" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("private_host");
    expect(mServer.findUnique).not.toHaveBeenCalled();
  });

  it("admin can install against a private IP (no host filter for admins)", async () => {
    mServer.findUnique.mockResolvedValue(null);
    // The admin path proceeds past the uniqueness check into streamSSE,
    // which we don't drive here — assert we got past the host filter
    // by checking that findUnique was consulted.
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/install-relay",
      asJson({ ...validBody, host: "192.168.1.10" }),
    );
    // streamSSE returns 200 with text/event-stream once entered.
    expect([200, 500]).toContain(res.status); // tolerant — the SSH layer will fail in test env
    expect(mServer.findUnique).toHaveBeenCalledWith({ where: { host: "192.168.1.10" } });
  });

  it("rejects non-JSON body with 400 for non-admin", async () => {
    const res = await appFor({ userId: "user-a", isAdmin: false }).request(
      "/servers/install-relay",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      },
    );
    expect(res.status).toBe(400);
  });

  // Contract pin for the join in the 400 branch (servers.ts, install-relay):
  // zod issues are joined into the message with "; " and nothing else. This
  // body fails two independent checks (bad traefikEmail, no ssh credential),
  // so changing the separator, or only the separator at this site, turns
  // it red.
  it("joins the two validation issue messages with '; ' verbatim", async () => {
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/install-relay",
      asJson({ name: "v", host: "h", traefikEmail: "nope" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "bad_request",
      message:
        "Invalid email address; exactly one of sshPassword or sshPrivateKey must be provided",
    });
  });
});

const installOkOutput = (token: string) =>
  `\n  Mode:  greenfield\n  URL:   https://relay.example.com\n  Token: ${token}\n`;

function mockSsh({
  stdout = "",
  stderr,
  exitCode = 0,
  finished = true,
}: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  finished?: boolean;
}) {
  vi.mocked(executeSshCommand).mockImplementation(async (opts) => {
    if (stdout && opts.onStdout) {
      for (const line of stdout.split("\n")) opts.onStdout(line);
    }
    if (stderr && opts.onStderr) {
      for (const line of stderr.split("\n")) opts.onStderr(line);
    }
    return { exitCode, finished };
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
    if (dataStr) events.push({ event, data: JSON.parse(dataStr) });
  }
  return events;
}

describe("POST /servers/install-relay (stream): exit code of the install command", () => {
  const FETCH_LINE = "curl: (22) The requested URL returned error: 404";
  const run = async () => {
    const res = await appFor({ userId: null, isAdmin: true }).request(
      "/servers/install-relay",
      asJson(validBody),
    );
    expect(res.status).toBe(200);
    return readSse(res);
  };
  const errorEvents = (events: Array<{ event: string; data: any }>) =>
    events.filter((e) => e.event === "error");
  const auditActions = () =>
    vi.mocked(prisma.auditLog.create).mock.calls.map((c) => [c[0].data.action, c[0].data.detail]);

  beforeEach(() => {
    vi.clearAllMocks();
    mServer.findUnique.mockResolvedValue(null);
    mServer.create.mockResolvedValue({
      id: "srv-new",
      name: "vps-1",
      host: "1.2.3.4",
      relayUrl: "https://relay.example.com",
    });
  });

  it("sends the fetch-first command: download, then run the file as root, no pipe", async () => {
    mockSsh({ stdout: installOkOutput("tok") });
    await run();
    const command = vi.mocked(executeSshCommand).mock.calls[0]?.[0]?.command ?? "";
    expect(command).toContain("curl -fsSL");
    expect(command).toContain("|| exit 97;");
    expect(command).not.toContain("| sudo");
    expect(command).not.toContain("sudo rm");
    expect(command.indexOf("curl -fsSL")).toBeLessThan(command.indexOf('sudo -E bash "$f"'));
  });

  it("empty output + exit 97: installer_fetch_failed with curl's line, no row", async () => {
    mockSsh({ stderr: FETCH_LINE, exitCode: 97 });
    const events = await run();
    expect(errorEvents(events)).toEqual([
      {
        event: "error",
        data: { kind: "installer_fetch_failed", message: `could not download the installer: ${FETCH_LINE}` },
      },
    ]);
    expect(events.some((e) => e.event === "done")).toBe(false);
    expect(mServer.create).not.toHaveBeenCalled();
    expect(auditActions()).toEqual([["server.install-relay.failed", "installer_fetch_failed"]]);
  });

  it("empty output + exit 1: installer_failed with the exit code, not url_not_found", async () => {
    mockSsh({ exitCode: 1 });
    const events = await run();
    const [err] = errorEvents(events);
    expect(err.data.kind).toBe("installer_failed");
    expect(err.data.message).toContain("code 1");
    expect(mServer.create).not.toHaveBeenCalled();
    expect(auditActions()).toEqual([["server.install-relay.failed", "installer_failed"]]);
  });

  it("complete URL/Token block + exit 1 is still an error, no row", async () => {
    mockSsh({ stdout: installOkOutput("late-fail-tok"), exitCode: 1 });
    const events = await run();
    expect(errorEvents(events).map((e) => e.data.kind)).toEqual(["installer_failed"]);
    expect(events.some((e) => e.event === "done")).toBe(false);
    expect(mServer.create).not.toHaveBeenCalled();
  });

  it("no exit code reported (-1) is a failed installer", async () => {
    mockSsh({ stdout: installOkOutput("t"), exitCode: -1 });
    const events = await run();
    expect(errorEvents(events).map((e) => e.data.kind)).toEqual(["installer_failed"]);
    expect(mServer.create).not.toHaveBeenCalled();
  });

  it("a command that did not finish keeps the timeout mapping", async () => {
    mockSsh({ exitCode: -1, finished: false });
    const events = await run();
    expect(errorEvents(events).map((e) => e.data.kind)).toEqual(["timeout"]);
    expect(mServer.create).not.toHaveBeenCalled();
    expect(auditActions()).toEqual([["server.install-relay.failed", "timeout"]]);
  });

  it("exit 0 + valid output is unchanged: the row is created and done is sent", async () => {
    mockSsh({ stdout: installOkOutput("good-tok") });
    const events = await run();
    expect(errorEvents(events)).toEqual([]);
    expect(events.some((e) => e.event === "done")).toBe(true);
    expect(mServer.create).toHaveBeenCalledTimes(1);
    expect(mServer.create.mock.calls[0]?.[0].data.relayToken).toBe("good-tok");
    expect(auditActions()[0]?.[0]).toBe("server.install-relay.success");
  });

  it("exit 0 + output without a URL keeps today's parse error", async () => {
    mockSsh({ stdout: "nothing useful\n" });
    const events = await run();
    expect(errorEvents(events).map((e) => e.data.kind)).toEqual(["url_not_found"]);
    expect(mServer.create).not.toHaveBeenCalled();
  });
});
