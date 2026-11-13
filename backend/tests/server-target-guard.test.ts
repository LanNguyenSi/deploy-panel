// Non-admin actors must not make the panel connect to private/loopback
// targets through a registered server: registration (POST/PATCH) and every
// SSH to `host` / fetch of `relayUrl` in the per-id routes re-check the
// guard. Admins are never filtered.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// These tests assert route behaviour against a mocked global fetch; the
// connect-guarded transport (lib/guarded-fetch.ts) is covered in
// connect-guard.test.ts, so here it forwards to the same fetch.
vi.mock("../src/lib/guarded-fetch.js", () => ({
  guardedFetch: vi.fn((url: string, init?: RequestInit) => globalThis.fetch(url, init)),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

// Drives the guard's DNS pass. Default: every name resolves to a public
// address; individual tests override.
const lookupMock = vi.fn();
vi.mock("node:dns", () => ({
  promises: {
    lookup: (...args: unknown[]) => lookupMock(...args),
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

vi.mock("../src/services/ssh-executor.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/ssh-executor.js")>(
    "../src/services/ssh-executor.js",
  );
  return { ...actual, executeSshCommand: vi.fn() };
});

// getLatestRelayRevision would fetch GHCR over the network; stub it.
vi.mock("../src/lib/ghcr.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/ghcr.js")>(
    "../src/lib/ghcr.js",
  );
  return { ...actual, getLatestRelayRevision: vi.fn().mockResolvedValue(null) };
});

import { prisma } from "../src/lib/prisma.js";
import { config } from "../src/config/index.js";
import { serversRouter } from "../src/routes/servers.js";
import { executeSshCommand } from "../src/services/ssh-executor.js";
import { guardedFetch } from "../src/lib/guarded-fetch.js";
import { activeInstalls } from "../src/services/active-installs.js";
import { assertServerTargetsAllowed } from "../src/services/probe-guard.js";

const mServer = prisma.server as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

type ActorVars = {
  Variables: { userId?: string; isAdmin?: boolean; authType?: string };
};

const NON_ADMIN = { userId: "user-a", isAdmin: false };
const ADMIN = { userId: null, isAdmin: true };

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

const send = (method: string, body?: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const sshBody = { sshUser: "root", sshPort: 22, sshPassword: "hunter2" };

function serverRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "srv-a",
    userId: "user-a",
    name: "vps-a",
    host: "203.0.113.10",
    relayUrl: "https://relay.example.com",
    relayToken: "tok",
    relayMode: null,
    relayDir: null,
    relayComposeFile: null,
    hostKeySha256: "fp".padEnd(44, "="),
    ...overrides,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  config.TRUSTED_RELAY_SERVER_IDS.length = 0;
  activeInstalls.clear();
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "203.0.113.4", family: 4 }]);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ revision: "abc1234" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(executeSshCommand).mockResolvedValue({ exitCode: 0, finished: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function expectPrivateHost(res: Response, field: "host" | "relayUrl") {
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string; field: string };
  expect(body.error).toBe("private_host");
  expect(body.field).toBe(field);
}

describe("assertServerTargetsAllowed", () => {
  it("never filters or resolves for an admin", async () => {
    const r = await assertServerTargetsAllowed(
      { isAdmin: true },
      { host: "10.0.0.1", relayUrl: "http://127.0.0.1:3000" },
    );
    expect(r).toEqual({ ok: true });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("checks only the targets it is given", async () => {
    const hostOnly = await assertServerTargetsAllowed(
      { isAdmin: false },
      { host: "203.0.113.10", relayUrl: "http://127.0.0.1:3000" },
    );
    expect(hostOnly).toEqual({ ok: false, field: "relayUrl", reason: "literal" });
    const relayNotPassed = await assertServerTargetsAllowed(
      { isAdmin: false },
      { host: "203.0.113.10" },
    );
    expect(relayNotPassed).toEqual({ ok: true });
    const nullTargets = await assertServerTargetsAllowed(
      { isAdmin: false },
      { host: null, relayUrl: null },
    );
    expect(nullTargets).toEqual({ ok: true });
  });

  it("reports host before relayUrl when both are private", async () => {
    const r = await assertServerTargetsAllowed(
      { isAdmin: false },
      { host: "10.0.0.1", relayUrl: "http://127.0.0.1" },
    );
    expect(r).toEqual({ ok: false, field: "host", reason: "literal" });
  });

  it.each([
    ["http://127.0.0.1:8080", "literal"],
    ["http://localhost:8080", "literal"],
    ["http://169.254.169.254/latest/meta-data", "literal"],
    ["http://[::1]:8080", "literal"],
    ["http://127.1/", "literal"],
    ["http://2130706433/", "literal"],
    ["http://[::ffff:7f00:1]/", "literal"],
  ])("denies relayUrl %s", async (relayUrl, reason) => {
    const r = await assertServerTargetsAllowed({ isAdmin: false }, { relayUrl });
    expect(r).toEqual({ ok: false, field: "relayUrl", reason });
  });

  it("tells an unparsable relayUrl apart from a private one", async () => {
    for (const relayUrl of ["not a url", "http://<set-host-ip>:3001"]) {
      expect(await assertServerTargetsAllowed({ isAdmin: false }, { relayUrl })).toEqual({
        ok: false,
        field: "relayUrl",
        reason: "unparsable",
      });
    }
  });

  it("denies a relayUrl hostname that resolves to a private address", async () => {
    lookupMock.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
    const r = await assertServerTargetsAllowed(
      { isAdmin: false },
      { relayUrl: "https://internal.attacker.example/" },
    );
    expect(r).toEqual({ ok: false, field: "relayUrl", reason: "resolved_private" });
    expect(lookupMock).toHaveBeenCalledWith("internal.attacker.example", expect.anything());
  });

  it("allows a public relayUrl and a public IPv6 literal", async () => {
    expect(
      await assertServerTargetsAllowed({ isAdmin: false }, { relayUrl: "https://relay.example.com" }),
    ).toEqual({ ok: true });
    lookupMock.mockClear();
    expect(
      await assertServerTargetsAllowed({ isAdmin: false }, { relayUrl: "http://[2001:db8::1]:3000" }),
    ).toEqual({ ok: true });
    // Brackets are stripped before the DNS pass.
    expect(lookupMock).toHaveBeenCalledWith("2001:db8::1", expect.anything());
  });
});

describe("a stored relayUrl that is not a URL", () => {
  it("answers 400 invalid_relay_url to a non-admin before any fetch", async () => {
    mServer.findUnique.mockResolvedValue(serverRow({ relayUrl: "http://<set-host-ip>:3001" }));
    const res = await appFor(NON_ADMIN).request("/servers/srv-a/system");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; field: string };
    expect(body.error).toBe("invalid_relay_url");
    expect(body.field).toBe("relayUrl");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /servers (registration)", () => {
  const body = (overrides: Record<string, unknown> = {}) => ({
    name: "vps-a",
    host: "203.0.113.10",
    ...overrides,
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["RFC1918", "10.0.0.5"],
    ["cloud metadata", "169.254.169.254"],
    ["localhost", "localhost"],
  ])("rejects a non-admin with a %s host", async (_label, host) => {
    const res = await appFor(NON_ADMIN).request("/servers", send("POST", body({ host })));
    await expectPrivateHost(res, "host");
    expect(mServer.create).not.toHaveBeenCalled();
  });

  it("rejects a non-admin whose host resolves to a private address", async () => {
    lookupMock.mockResolvedValue([{ address: "192.168.1.5", family: 4 }]);
    const res = await appFor(NON_ADMIN).request(
      "/servers",
      send("POST", body({ host: "sneaky.attacker.example" })),
    );
    await expectPrivateHost(res, "host");
    expect(mServer.create).not.toHaveBeenCalled();
  });

  it("rejects a non-admin with a private relayUrl host", async () => {
    const res = await appFor(NON_ADMIN).request(
      "/servers",
      send("POST", body({ relayUrl: "http://169.254.169.254/latest" })),
    );
    await expectPrivateHost(res, "relayUrl");
    expect(mServer.create).not.toHaveBeenCalled();
  });

  it("allows an admin with a private host and a private relayUrl (unchanged)", async () => {
    mServer.findUnique.mockResolvedValue(null);
    mServer.create.mockResolvedValue(serverRow({ userId: null, host: "10.0.0.5" }));
    const res = await appFor(ADMIN).request(
      "/servers",
      send("POST", body({ host: "10.0.0.5", relayUrl: "http://127.0.0.1:3000" })),
    );
    expect(res.status).toBe(201);
    expect(mServer.create).toHaveBeenCalledTimes(1);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("still lets a non-admin register a public host and relayUrl", async () => {
    mServer.findUnique.mockResolvedValue(null);
    mServer.create.mockResolvedValue(serverRow());
    const res = await appFor(NON_ADMIN).request(
      "/servers",
      send("POST", body({ relayUrl: "https://relay.example.com" })),
    );
    expect(res.status).toBe(201);
    expect(mServer.create).toHaveBeenCalledTimes(1);
  });
});

describe("PATCH /servers/:id", () => {
  beforeEach(() => {
    mServer.findUnique.mockResolvedValue(serverRow());
  });

  it("rejects a non-admin changing host to a private address", async () => {
    const res = await appFor(NON_ADMIN).request(
      "/servers/srv-a",
      send("PATCH", { host: "10.0.0.9" }),
    );
    await expectPrivateHost(res, "host");
    expect(mServer.update).not.toHaveBeenCalled();
  });

  it("rejects a non-admin changing relayUrl to a private host", async () => {
    const res = await appFor(NON_ADMIN).request(
      "/servers/srv-a",
      send("PATCH", { relayUrl: "http://127.0.0.1:9000" }),
    );
    await expectPrivateHost(res, "relayUrl");
    expect(mServer.update).not.toHaveBeenCalled();
  });

  it("allows an admin to patch to a private host (unchanged)", async () => {
    mServer.update.mockResolvedValue(serverRow({ host: "10.0.0.9" }));
    const res = await appFor(ADMIN).request(
      "/servers/srv-a",
      send("PATCH", { host: "10.0.0.9", relayUrl: "http://127.0.0.1:9000" }),
    );
    expect(res.status).toBe(200);
    expect(mServer.update).toHaveBeenCalledTimes(1);
  });

  it("allows a non-admin to patch a public host and an unrelated field", async () => {
    mServer.update.mockResolvedValue(serverRow({ host: "203.0.113.77" }));
    const res = await appFor(NON_ADMIN).request(
      "/servers/srv-a",
      send("PATCH", { host: "203.0.113.77" }),
    );
    expect(res.status).toBe(200);
    // Renaming a legacy row that already holds a private relayUrl is not
    // blocked at PATCH (only the fields in the body are checked); its use
    // sites are guarded instead.
    mServer.findUnique.mockResolvedValue(serverRow({ relayUrl: "http://10.0.0.1" }));
    const rename = await appFor(NON_ADMIN).request(
      "/servers/srv-a",
      send("PATCH", { name: "renamed" }),
    );
    expect(rename.status).toBe(200);
  });
});

describe("per-id SSH routes on a pre-existing row with an internal host", () => {
  const internal = () => serverRow({ host: "10.0.0.7" });

  it("install-relay: non-admin is rejected before any SSH", async () => {
    mServer.findUnique.mockResolvedValue(internal());
    const res = await appFor(NON_ADMIN).request(
      "/servers/srv-a/install-relay",
      send("POST", sshBody),
    );
    await expectPrivateHost(res, "host");
    expect(executeSshCommand).not.toHaveBeenCalled();
  });

  it("install-relay: a host that now resolves private is rejected before any SSH", async () => {
    mServer.findUnique.mockResolvedValue(serverRow({ host: "moved.example.com" }));
    lookupMock.mockResolvedValue([{ address: "172.16.0.4", family: 4 }]);
    const res = await appFor(NON_ADMIN).request(
      "/servers/srv-a/install-relay",
      send("POST", sshBody),
    );
    await expectPrivateHost(res, "host");
    expect(executeSshCommand).not.toHaveBeenCalled();
  });

  it("install-relay: admin still reaches SSH on an internal host", async () => {
    mServer.findUnique.mockResolvedValue(internal());
    vi.mocked(executeSshCommand).mockImplementation(async (opts) => {
      opts.onStdout?.("  URL:   https://relay.example.com");
      opts.onStdout?.("  Token: tok");
      return { exitCode: 0, finished: true };
    });
    const res = await appFor(ADMIN).request("/servers/srv-a/install-relay", send("POST", sshBody));
    await res.text();
    expect(executeSshCommand).toHaveBeenCalled();
  });

  it("install-relay: a public host reaches SSH for a non-admin", async () => {
    mServer.findUnique.mockResolvedValue(serverRow());
    vi.mocked(executeSshCommand).mockImplementation(async (opts) => {
      opts.onStdout?.("  URL:   https://relay.example.com");
      opts.onStdout?.("  Token: tok");
      return { exitCode: 0, finished: true };
    });
    const res = await appFor(NON_ADMIN).request(
      "/servers/srv-a/install-relay",
      send("POST", sshBody),
    );
    await res.text();
    expect(executeSshCommand).toHaveBeenCalled();
  });

  it("update-relay-image: non-admin is rejected before any SSH or fetch (internal host)", async () => {
    mServer.findUnique.mockResolvedValue(internal());
    const res = await appFor(NON_ADMIN).request(
      "/servers/srv-a/update-relay-image",
      send("POST", sshBody),
    );
    await expectPrivateHost(res, "host");
    expect(executeSshCommand).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("update-relay-image: non-admin is rejected before any SSH or fetch (internal relayUrl)", async () => {
    mServer.findUnique.mockResolvedValue(serverRow({ relayUrl: "http://169.254.169.254" }));
    const res = await appFor(NON_ADMIN).request(
      "/servers/srv-a/update-relay-image",
      send("POST", sshBody),
    );
    await expectPrivateHost(res, "relayUrl");
    expect(executeSshCommand).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("update-relay-image: admin still reaches SSH on an internal host", async () => {
    mServer.findUnique.mockResolvedValue(internal());
    const res = await appFor(ADMIN).request(
      "/servers/srv-a/update-relay-image",
      send("POST", sshBody),
    );
    await res.text();
    expect(executeSshCommand).toHaveBeenCalled();
  });

  it("update-relay-image: a public host and relayUrl reach SSH for a non-admin", async () => {
    mServer.findUnique.mockResolvedValue(serverRow());
    const res = await appFor(NON_ADMIN).request(
      "/servers/srv-a/update-relay-image",
      send("POST", sshBody),
    );
    await res.text();
    expect(executeSshCommand).toHaveBeenCalled();
  });
});

describe("per-id relay fetch routes on a pre-existing row with an internal relayUrl", () => {
  const internal = () => serverRow({ relayUrl: "http://169.254.169.254/latest" });

  const cases: Array<[string, string, string]> = [
    ["test", "POST", "/servers/srv-a/test"],
    ["system", "GET", "/servers/srv-a/system"],
    ["relay-status", "GET", "/servers/srv-a/relay-status"],
    ["relay-self-update", "POST", "/servers/srv-a/relay-self-update"],
  ];

  it.each(cases)("%s: non-admin is rejected before any fetch", async (_n, method, path) => {
    mServer.findUnique.mockResolvedValue(internal());
    const res = await appFor(NON_ADMIN).request(path, send(method, method === "POST" ? {} : undefined));
    await expectPrivateHost(res, "relayUrl");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(cases)("%s: a relayUrl that now resolves private is rejected", async (_n, method, path) => {
    mServer.findUnique.mockResolvedValue(serverRow({ relayUrl: "https://rebound.example.com" }));
    lookupMock.mockResolvedValue([{ address: "10.9.9.9", family: 4 }]);
    const res = await appFor(NON_ADMIN).request(path, send(method, method === "POST" ? {} : undefined));
    await expectPrivateHost(res, "relayUrl");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(cases)("%s: admin still fetches the internal relayUrl", async (_n, method, path) => {
    mServer.findUnique.mockResolvedValue(internal());
    const res = await appFor(ADMIN).request(path, send(method, method === "POST" ? {} : undefined));
    await res.text();
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toContain("169.254.169.254");
  });

  it.each(cases)("%s: public relayUrl is fetched for a non-admin", async (_n, method, path) => {
    mServer.findUnique.mockResolvedValue(serverRow());
    const res = await appFor(NON_ADMIN).request(path, send(method, method === "POST" ? {} : undefined));
    await res.text();
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toContain("relay.example.com");
  });
});

describe("TRUSTED_RELAY_SERVER_IDS on the per-id routes", () => {
  const internalRelay = () => serverRow({ relayUrl: "http://169.254.169.254/latest" });
  const internalHost = () => serverRow({ host: "10.0.0.7" });
  const fetchCases: Array<[string, string, string]> = [
    ["test", "POST", "/servers/srv-a/test"],
    ["system", "GET", "/servers/srv-a/system"],
    ["relay-status", "GET", "/servers/srv-a/relay-status"],
    ["relay-self-update", "POST", "/servers/srv-a/relay-self-update"],
  ];

  it.each(fetchCases)("%s: a listed id fetches the private relayUrl for a non-admin", async (_n, method, path) => {
    config.TRUSTED_RELAY_SERVER_IDS.push("srv-a");
    mServer.findUnique.mockResolvedValue(internalRelay());
    const res = await appFor(NON_ADMIN).request(path, send(method, method === "POST" ? {} : undefined));
    await res.text();
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toContain("169.254.169.254");
  });

  it.each(fetchCases)("%s: an id that is not listed is still rejected", async (_n, method, path) => {
    config.TRUSTED_RELAY_SERVER_IDS.push("srv-other");
    mServer.findUnique.mockResolvedValue(internalRelay());
    const res = await appFor(NON_ADMIN).request(path, send(method, method === "POST" ? {} : undefined));
    await expectPrivateHost(res, "relayUrl");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("install-relay: a listed id reaches SSH on a private host", async () => {
    config.TRUSTED_RELAY_SERVER_IDS.push("srv-a");
    mServer.findUnique.mockResolvedValue(internalHost());
    const res = await appFor(NON_ADMIN).request("/servers/srv-a/install-relay", send("POST", sshBody));
    await res.text();
    expect(executeSshCommand).toHaveBeenCalled();
  });

  it("install-relay: an id that is not listed is rejected before any SSH", async () => {
    config.TRUSTED_RELAY_SERVER_IDS.push("srv-other");
    mServer.findUnique.mockResolvedValue(internalHost());
    const res = await appFor(NON_ADMIN).request("/servers/srv-a/install-relay", send("POST", sshBody));
    await expectPrivateHost(res, "host");
    expect(executeSshCommand).not.toHaveBeenCalled();
  });

  it("update-relay-image: a listed id reaches SSH with a private host and relayUrl", async () => {
    config.TRUSTED_RELAY_SERVER_IDS.push("srv-a");
    mServer.findUnique.mockResolvedValue(serverRow({ host: "10.0.0.7", relayUrl: "http://169.254.169.254" }));
    const res = await appFor(NON_ADMIN).request("/servers/srv-a/update-relay-image", send("POST", sshBody));
    await res.text();
    expect(executeSshCommand).toHaveBeenCalled();
  });

  describe("PATCH on a listed id is locked for non-admins", () => {
    const patch = (actor: { userId: string | null; isAdmin: boolean }, body: unknown) =>
      appFor(actor).request("/servers/srv-a", send("PATCH", body));

    async function expectLocked(res: Response) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("trusted_server_locked");
      expect(mServer.update).not.toHaveBeenCalled();
    }

    beforeEach(() => {
      config.TRUSTED_RELAY_SERVER_IDS.push("srv-a");
      mServer.findUnique.mockResolvedValue(internalRelay());
      mServer.update.mockResolvedValue(internalRelay());
    });

    it("relayUrl to a public value is refused with 403", async () => {
      await expectLocked(await patch(NON_ADMIN, { relayUrl: "https://relay.example.com" }));
    });

    it("relayUrl and host to private values are refused with 403 too (the lock comes first)", async () => {
      await expectLocked(await patch(NON_ADMIN, { relayUrl: "http://10.9.9.9:8222" }));
      await expectLocked(await patch(NON_ADMIN, { host: "10.0.0.9" }));
    });

    it("host to a public value is refused with 403", async () => {
      await expectLocked(await patch(NON_ADMIN, { host: "203.0.113.99" }));
    });

    it("name only is allowed (200)", async () => {
      const res = await patch(NON_ADMIN, { name: "renamed" });
      expect(res.status).toBe(200);
      expect(mServer.update).toHaveBeenCalledTimes(1);
    });

    it("resending the stored host and relayUrl unchanged is allowed (200)", async () => {
      const stored = serverRow();
      mServer.findUnique.mockResolvedValue(stored);
      const res = await patch(NON_ADMIN, { host: stored.host, relayUrl: stored.relayUrl });
      expect(res.status).toBe(200);
    });

    it("resending a stored private relayUrl is still a checked write (400 private_host)", async () => {
      const res = await patch(NON_ADMIN, { relayUrl: internalRelay().relayUrl });
      await expectPrivateHost(res, "relayUrl");
      expect(mServer.update).not.toHaveBeenCalled();
    });

    it("an admin may still change relayUrl on a listed id", async () => {
      mServer.findUnique.mockResolvedValue(serverRow({ userId: null, relayUrl: "http://10.0.0.5:8222" }));
      const res = await patch(ADMIN, { relayUrl: "https://relay.example.com" });
      expect(res.status).toBe(200);
      expect(mServer.update).toHaveBeenCalledTimes(1);
    });

    it("an id that is not listed keeps the unchanged PATCH behaviour", async () => {
      config.TRUSTED_RELAY_SERVER_IDS.length = 0;
      const ok = await patch(NON_ADMIN, { relayUrl: "https://relay.example.com" });
      expect(ok.status).toBe(200);
      const denied = await patch(NON_ADMIN, { relayUrl: "http://10.9.9.9:8222" });
      await expectPrivateHost(denied, "relayUrl");
    });
  });

  it("POST: a new server with a private relayUrl is rejected even when ids are listed", async () => {
    config.TRUSTED_RELAY_SERVER_IDS.push("srv-a", "srv-new");
    mServer.findUnique.mockResolvedValue(null);
    lookupMock.mockImplementation(async (name: string) => [
      { address: name === "agent-relay" ? "172.18.0.5" : "203.0.113.4", family: 4 },
    ]);
    const res = await appFor(NON_ADMIN).request(
      "/servers",
      send("POST", { name: "vps-new", host: "203.0.113.10", relayUrl: "http://agent-relay:8222" }),
    );
    await expectPrivateHost(res, "relayUrl");
    expect(mServer.create).not.toHaveBeenCalled();
  });
});

describe("assertServerTargetsAllowed with a stored server id", () => {
  it("skips the check, and any lookup, only for a listed id", async () => {
    config.TRUSTED_RELAY_SERVER_IDS.push("srv-a");
    const targets = { host: "10.0.0.1", relayUrl: "http://agent-relay:8222" };
    expect(await assertServerTargetsAllowed({ isAdmin: false }, targets, "srv-a")).toEqual({ ok: true });
    expect(lookupMock).not.toHaveBeenCalled();
    expect(await assertServerTargetsAllowed({ isAdmin: false }, targets, "srv-b")).toEqual({
      ok: false,
      field: "host",
      reason: "literal",
    });
    // No id passed (a write path): never exempt, even when ids are listed.
    expect(await assertServerTargetsAllowed({ isAdmin: false }, targets)).toEqual({
      ok: false,
      field: "host",
      reason: "literal",
    });
  });
});

describe("installer-reported relay URL is checked before it is stored", () => {
  const installOutput = (url: string) => (opts: { onStdout?: (l: string) => void }) => {
    opts.onStdout?.(`  URL:   ${url}`);
    opts.onStdout?.("  Token: tok");
  };

  async function readSseEvents(res: Response) {
    const text = await res.text();
    const events: Array<{ event: string; data: any }> = [];
    for (const block of text.split("\n\n")) {
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) events.push({ event, data: JSON.parse(data) });
    }
    return events;
  }

  const firstInstallBody = {
    name: "vps-new",
    host: "203.0.113.50",
    relayDomain: "relay.example.com",
    traefikEmail: "ops@example.com",
    ...sshBody,
  };

  it("first install: non-admin cannot persist an internal relay URL", async () => {
    mServer.findUnique.mockResolvedValue(null);
    vi.mocked(executeSshCommand).mockImplementation(async (opts) => {
      installOutput("http://169.254.169.254/latest")(opts);
      return { exitCode: 0, finished: true };
    });
    const res = await appFor(NON_ADMIN).request(
      "/servers/install-relay",
      send("POST", firstInstallBody),
    );
    const events = await readSseEvents(res);
    expect(events.find((e) => e.event === "error")?.data.kind).toBe("private_host");
    expect(events.find((e) => e.event === "done")).toBeUndefined();
    expect(mServer.create).not.toHaveBeenCalled();
  });

  it("first install: a placeholder relay URL is reported as relay_url_invalid, not private_host", async () => {
    mServer.findUnique.mockResolvedValue(null);
    vi.mocked(executeSshCommand).mockImplementation(async (opts) => {
      installOutput("http://<set-host-ip>:3001")(opts);
      return { exitCode: 0, finished: true };
    });
    const res = await appFor(NON_ADMIN).request(
      "/servers/install-relay",
      send("POST", firstInstallBody),
    );
    const events = await readSseEvents(res);
    const err = events.find((e) => e.event === "error")?.data;
    expect(err?.kind).toBe("relay_url_invalid");
    expect(err?.message).toMatch(/public relay domain/);
    expect(mServer.create).not.toHaveBeenCalled();
  });

  it("first install: a private relay URL says so and asks for a public relay domain", async () => {
    mServer.findUnique.mockResolvedValue(null);
    vi.mocked(executeSshCommand).mockImplementation(async (opts) => {
      installOutput("http://10.0.0.5:3001")(opts);
      return { exitCode: 0, finished: true };
    });
    const res = await appFor(NON_ADMIN).request(
      "/servers/install-relay",
      send("POST", firstInstallBody),
    );
    const err = (await readSseEvents(res)).find((e) => e.event === "error")?.data;
    expect(err?.kind).toBe("private_host");
    expect(err?.message).toMatch(/private\/loopback/);
    expect(err?.message).toMatch(/public relay domain/);
  });

  it("first install: SSH pins a checked address for a non-admin and not for an admin", async () => {
    mServer.findUnique.mockResolvedValue(null);
    vi.mocked(executeSshCommand).mockImplementation(async (opts) => {
      installOutput("http://10.0.0.5:3001")(opts);
      return { exitCode: 0, finished: true };
    });
    await readSseEvents(await appFor(NON_ADMIN).request("/servers/install-relay", send("POST", firstInstallBody)));
    expect(vi.mocked(executeSshCommand).mock.calls.at(-1)![0].guardTarget).toBe(true);

    vi.mocked(executeSshCommand).mockClear();
    await readSseEvents(await appFor(ADMIN).request("/servers/install-relay", send("POST", firstInstallBody)));
    expect(vi.mocked(executeSshCommand).mock.calls.at(-1)![0].guardTarget).toBe(false);
  });

  it("re-install: a placeholder relay URL is reported as relay_url_invalid and not stored", async () => {
    mServer.findUnique.mockResolvedValue(serverRow());
    vi.mocked(executeSshCommand).mockImplementation(async (opts) => {
      installOutput("http://<set-host-ip>:3001")(opts);
      return { exitCode: 0, finished: true };
    });
    const res = await appFor(NON_ADMIN).request(
      "/servers/srv-a/install-relay",
      send("POST", sshBody),
    );
    const events = await readSseEvents(res);
    const err = events.find((e) => e.event === "error")?.data;
    expect(err?.kind).toBe("relay_url_invalid");
    expect(err?.message).toMatch(/public relay domain/);
    expect(mServer.update.mock.calls.filter((c) => c[0]?.data?.relayUrl !== undefined)).toHaveLength(0);
  });

  it("first install: admin may store a placeholder relay URL (unchanged)", async () => {
    mServer.findUnique.mockResolvedValue(null);
    mServer.create.mockResolvedValue(serverRow({ userId: null }));
    vi.mocked(executeSshCommand).mockImplementation(async (opts) => {
      installOutput("http://<set-host-ip>:3001")(opts);
      return { exitCode: 0, finished: true };
    });
    const res = await appFor(ADMIN).request("/servers/install-relay", send("POST", firstInstallBody));
    const events = await readSseEvents(res);
    expect(events.find((e) => e.event === "done")).toBeDefined();
  });

  it("first install: admin keeps an internal relay URL", async () => {
    mServer.findUnique.mockResolvedValue(null);
    mServer.create.mockResolvedValue(serverRow({ userId: null }));
    vi.mocked(executeSshCommand).mockImplementation(async (opts) => {
      installOutput("http://10.0.0.5:3000")(opts);
      return { exitCode: 0, finished: true };
    });
    const res = await appFor(ADMIN).request(
      "/servers/install-relay",
      send("POST", firstInstallBody),
    );
    const events = await readSseEvents(res);
    expect(events.find((e) => e.event === "done")).toBeDefined();
    expect(mServer.create).toHaveBeenCalledTimes(1);
  });

  it("re-install: non-admin cannot overwrite relayUrl with an internal one", async () => {
    mServer.findUnique.mockResolvedValue(serverRow());
    vi.mocked(executeSshCommand).mockImplementation(async (opts) => {
      installOutput("http://127.0.0.1:3000")(opts);
      return { exitCode: 0, finished: true };
    });
    const res = await appFor(NON_ADMIN).request(
      "/servers/srv-a/install-relay",
      send("POST", sshBody),
    );
    const events = await readSseEvents(res);
    expect(events.find((e) => e.event === "error")?.data.kind).toBe("private_host");
    expect(events.find((e) => e.event === "done")).toBeUndefined();
    const relayUrlWrites = mServer.update.mock.calls.filter(
      (c) => c[0]?.data?.relayUrl !== undefined,
    );
    expect(relayUrlWrites).toHaveLength(0);
  });

  it("re-install: admin may store an internal relayUrl", async () => {
    mServer.findUnique.mockResolvedValue(serverRow({ userId: null }));
    vi.mocked(executeSshCommand).mockImplementation(async (opts) => {
      installOutput("http://127.0.0.1:3000")(opts);
      return { exitCode: 0, finished: true };
    });
    const res = await appFor(ADMIN).request("/servers/srv-a/install-relay", send("POST", sshBody));
    const events = await readSseEvents(res);
    expect(events.find((e) => e.event === "done")).toBeDefined();
    const relayUrlWrites = mServer.update.mock.calls.filter(
      (c) => c[0]?.data?.relayUrl === "http://127.0.0.1:3000",
    );
    expect(relayUrlWrites).toHaveLength(1);
  });
});

// Connect-time flags: the pre-check above resolves once; these rows are also
// connected through the checking lookup (HTTP) or an address pinned by it
// (SSH). The transports themselves are covered in connect-guard.test.ts.
describe("connect-time guard flags on the per-id routes", () => {
  const fetchRoutes: Array<[string, string, string]> = [
    ["test", "POST", "/servers/srv-a/test"],
    ["system", "GET", "/servers/srv-a/system"],
    ["relay-status", "GET", "/servers/srv-a/relay-status"],
    ["relay-self-update", "POST", "/servers/srv-a/relay-self-update"],
  ];
  const sshRoutes: Array<[string, string]> = [
    ["install-relay", "/servers/srv-a/install-relay"],
    ["update-relay-image", "/servers/srv-a/update-relay-image"],
  ];

  it.each(fetchRoutes)("%s: a non-admin's relay is fetched through the guarded transport", async (_n, method, path) => {
    mServer.findUnique.mockResolvedValue(serverRow());
    const res = await appFor(NON_ADMIN).request(path, send(method, method === "POST" ? {} : undefined));
    await res.text();
    expect(guardedFetch).toHaveBeenCalled();
    expect(vi.mocked(guardedFetch).mock.calls[0][0]).toContain("relay.example.com");
    // every request to the relay went through it, none through the plain fetch
    const relayCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("relay.example.com"));
    expect(relayCalls.length).toBe(vi.mocked(guardedFetch).mock.calls.length);
  });

  it("update-relay-image: the SSH inspect and install and the health check are all guarded for a non-admin", async () => {
    mServer.findUnique.mockResolvedValue(serverRow());
    vi.mocked(executeSshCommand).mockImplementation(async (opts) => ({
      exitCode: opts.command.includes("grep") ? 1 : 0,
      finished: true,
    }));
    await (await appFor(NON_ADMIN).request("/servers/srv-a/update-relay-image", send("POST", sshBody))).text();
    const calls = vi.mocked(executeSshCommand).mock.calls;
    expect(calls.length).toBe(2);
    for (const call of calls) expect(call[0].guardTarget).toBe(true);
    const relayCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("relay.example.com"));
    expect(relayCalls.length).toBeGreaterThan(0);
    expect(relayCalls.length).toBe(vi.mocked(guardedFetch).mock.calls.length);
  });

  it.each(fetchRoutes)("%s: an admin on the same owned row keeps the plain fetch", async (_n, method, path) => {
    mServer.findUnique.mockResolvedValue(serverRow());
    const res = await appFor(ADMIN).request(path, send(method, method === "POST" ? {} : undefined));
    await res.text();
    expect(fetchMock).toHaveBeenCalled();
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it.each(fetchRoutes)("%s: a listed id keeps the plain fetch for a non-admin", async (_n, method, path) => {
    config.TRUSTED_RELAY_SERVER_IDS.push("srv-a");
    mServer.findUnique.mockResolvedValue(serverRow());
    const res = await appFor(NON_ADMIN).request(path, send(method, method === "POST" ? {} : undefined));
    await res.text();
    expect(fetchMock).toHaveBeenCalled();
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it.each(sshRoutes)("%s: SSH for a non-admin pins a checked address; admin and a listed id do not", async (_n, path) => {
    mServer.findUnique.mockResolvedValue(serverRow());
    await (await appFor(NON_ADMIN).request(path, send("POST", sshBody))).text();
    expect(vi.mocked(executeSshCommand).mock.calls.length).toBeGreaterThan(0);
    for (const call of vi.mocked(executeSshCommand).mock.calls) expect(call[0].guardTarget).toBe(true);

    vi.mocked(executeSshCommand).mockClear();
    await (await appFor(ADMIN).request(path, send("POST", sshBody))).text();
    expect(vi.mocked(executeSshCommand).mock.calls.length).toBeGreaterThan(0);
    for (const call of vi.mocked(executeSshCommand).mock.calls) expect(call[0].guardTarget).toBe(false);

    vi.mocked(executeSshCommand).mockClear();
    config.TRUSTED_RELAY_SERVER_IDS.push("srv-a");
    await (await appFor(NON_ADMIN).request(path, send("POST", sshBody))).text();
    expect(vi.mocked(executeSshCommand).mock.calls.length).toBeGreaterThan(0);
    for (const call of vi.mocked(executeSshCommand).mock.calls) expect(call[0].guardTarget).toBe(false);
  });
});
