// Two reader decisions that need the real relayRequest behind a real route or
// helper (relay-body-limit.test.ts covers the reader itself):
//  - an env answer at the relay's PUT maximum is larger than the default
//    answer cap and must still be read at every env read site;
//  - a rollback rejection whose body is longer than the message cap still
//    carries its `phase` to the app-status write (RelayError.body is kept
//    whole, only the message is cut).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("../src/lib/guarded-fetch.js", () => ({
  guardedFetch: vi.fn((url: string, init?: RequestInit) => globalThis.fetch(url, init)),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    app: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    deploy: {
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    envVarChange: { createMany: vi.fn().mockResolvedValue({ count: 0 }), findMany: vi.fn() },
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

vi.mock("../src/lib/audit.js", () => ({
  audit: vi.fn(),
  getActor: vi.fn(() => "panel"),
  getActorUserId: vi.fn(() => null),
}));

vi.mock("../src/lib/post-deploy-gate.js", () => ({
  verifyDeployHealth: vi.fn().mockResolvedValue({ healthy: true }),
}));

vi.mock("../src/lib/deploy-recovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/deploy-recovery.js")>();
  return { ...actual, recoverBrokenDeploy: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../src/lib/stream-deploy.js", () => ({ streamDeploy: vi.fn() }));

vi.mock("../src/lib/app-secrets.js", () => ({
  getDecryptedAppSecrets: vi.fn().mockResolvedValue([]),
  listAppSecretKeys: vi.fn().mockResolvedValue([]),
  listMaskedAppSecrets: vi.fn().mockResolvedValue([]),
  setAppSecret: vi.fn(),
  deleteAppSecret: vi.fn(),
}));

import { prisma } from "../src/lib/prisma.js";
import { RELAY_ENV_MAX_BYTES, RELAY_ERROR_BODY_MAX_BYTES, RELAY_RESPONSE_MAX_BYTES } from "../src/lib/relay-body.js";
import { getDecryptedAppSecrets } from "../src/lib/app-secrets.js";
import { provisionAndCheckAppSecrets } from "../src/lib/provision-secrets.js";
import { evaluateRequiredEnv } from "../src/lib/required-env-gate.js";
import { appsRouter, ENV_MAX_ENTRIES, ENV_MAX_KEY, ENV_MAX_VALUE } from "../src/routes/apps.js";
import { v1Router } from "../src/routes/v1.js";

const mServer = prisma.server as unknown as { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
const mApp = prisma.app as unknown as {
  upsert: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};
const mDeploy = prisma.deploy as unknown as {
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

const SERVER_ROW = {
  id: "srv-1",
  userId: null,
  name: "my-server",
  host: "203.0.113.10",
  relayUrl: "https://relay.example.test",
  relayToken: "tok",
};

type ActorVars = { Variables: { userId?: string; isAdmin?: boolean; authType?: string } };

function adminApp() {
  const app = new Hono<ActorVars>();
  app.use("/*", async (c, next) => {
    c.set("isAdmin", true);
    c.set("authType", "panel");
    await next();
  });
  app.route("/servers/:serverId/apps", appsRouter as unknown as Hono<ActorVars>);
  app.route("/v1", v1Router as unknown as Hono<ActorVars>);
  return app;
}

/** The env answer of an app at the relay's PUT maximum: 500 entries of a 128 character key and a 32,768 character value. */
const MAX_ENV_ANSWER = JSON.stringify({
  entries: Array.from({ length: ENV_MAX_ENTRIES }, (_, i) => ({
    key: i === 0 ? "REQUIRED_KEY".padEnd(ENV_MAX_KEY, "_") : `K${i}`.padEnd(ENV_MAX_KEY, "_"),
    value: "v".repeat(ENV_MAX_VALUE),
  })),
});
const REQUIRED_KEY = "REQUIRED_KEY".padEnd(ENV_MAX_KEY, "_");

beforeEach(() => {
  vi.clearAllMocks();
  mServer.findUnique.mockResolvedValue(SERVER_ROW);
  mServer.findFirst.mockResolvedValue(SERVER_ROW);
  mApp.upsert.mockResolvedValue({ id: "app-1", name: "my-app" });
  vi.mocked(getDecryptedAppSecrets).mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an env answer at the relay's PUT maximum", () => {
  it("is above the default answer cap and below the env cap", () => {
    expect(MAX_ENV_ANSWER.length).toBeGreaterThan(RELAY_RESPONSE_MAX_BYTES);
    expect(MAX_ENV_ANSWER.length).toBeLessThan(RELAY_ENV_MAX_BYTES);
  });

  it("is read by GET .../env", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(MAX_ENV_ANSWER));
    const res = await adminApp().request("/servers/srv-1/apps/my-app/env");
    expect(res.status).toBe(200);
    expect((await res.json()).entries).toHaveLength(ENV_MAX_ENTRIES);
  });

  it("is read by the prior read and the answer of PUT .../env", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(MAX_ENV_ANSWER));
    const res = await adminApp().request("/servers/srv-1/apps/my-app/env", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [{ key: "A", value: "1" }] }),
    });
    expect(res.status).toBe(200);
    expect(spy.mock.calls.map((c) => (c[1] as RequestInit).method)).toEqual(["GET", "PUT"]);
  });

  it("is read by provisioning (the GET alone when nothing changes)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(MAX_ENV_ANSWER));
    const result = await provisionAndCheckAppSecrets({
      serverId: "srv-1",
      appId: "app-1",
      appName: "my-app",
      requiredKeys: [REQUIRED_KEY],
    });
    expect(result).toEqual({ provisionedKeys: [], wrote: false, missing: [] });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("is read by provisioning's write answer", async () => {
    vi.mocked(getDecryptedAppSecrets).mockResolvedValue([{ key: "NEW_SECRET", value: "s" }] as never);
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(MAX_ENV_ANSWER));
    const result = await provisionAndCheckAppSecrets({
      serverId: "srv-1",
      appId: "app-1",
      appName: "my-app",
      requiredKeys: [],
    });
    expect(result.wrote).toBe(true);
    expect(spy.mock.calls.map((c) => (c[1] as RequestInit).method)).toEqual(["GET", "PUT"]);
  });

  it("is read by the required-env check (a key only the relay env holds still resolves)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(MAX_ENV_ANSWER));
    const check = await evaluateRequiredEnv({
      serverId: "srv-1",
      appId: "app-1",
      appName: "my-app",
      requiredKeys: [REQUIRED_KEY],
    });
    expect(check.missing).toEqual([]);
    expect(check.check?.passed).toBe(true);
  });
});

describe("a rollback rejection whose body is longer than the message cap", () => {
  // agent-relay's shape: the phase is serialised after the relay's stderr text.
  const longRejection = () =>
    new Response(JSON.stringify({ error: `Rebuild failed: ${"e".repeat(100 * 1024)}`, phase: "after_reset" }), {
      status: 400,
    });

  it("POST apps .../rollback: the row fails with a bounded message and the app ends unhealthy", async () => {
    mDeploy.create.mockResolvedValue({ id: "deploy-1", status: "running" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => longRejection());

    const res = await adminApp().request("/servers/srv-1/apps/my-app/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const message: string = (await res.json()).message;
    expect(message.length).toBe("Relay error (400): ".length + RELAY_ERROR_BODY_MAX_BYTES);
    expect(mApp.update).toHaveBeenCalledWith({ where: { id: "app-1" }, data: { status: "unhealthy" } });
    const failed = mDeploy.update.mock.calls.map((c) => c[0]).find((c) => c.data.status === "failed");
    expect(failed.data.log).toBe(message);
  });

  it("POST /v1/rollback: the row fails with a bounded message and the app ends unhealthy", async () => {
    mApp.findUnique.mockResolvedValue({ id: "app-1", name: "my-app", serverId: "srv-1" });
    mDeploy.create.mockResolvedValue({ id: "deploy-1", status: "running" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => longRejection());

    const res = await adminApp().request("/v1/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "my-server", app: "my-app" }),
    });
    expect(res.status).toBe(202);

    await vi.waitFor(() => expect(mApp.update).toHaveBeenCalledWith({ where: { id: "app-1" }, data: { status: "unhealthy" } }));
    const failed = mDeploy.update.mock.calls.map((c) => c[0]).find((c) => c.data.status === "failed");
    const [{ error }] = JSON.parse(failed.data.log);
    expect(error.length).toBe("Relay error (400): ".length + RELAY_ERROR_BODY_MAX_BYTES);
  });

  it("a short rejection tagged before_reset leaves the app status alone (the phase is read, not assumed)", async () => {
    mDeploy.create.mockResolvedValue({ id: "deploy-1", status: "running" });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ error: "bad ref", phase: "before_reset" }), { status: 400 }),
    );

    const res = await adminApp().request("/servers/srv-1/apps/my-app/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(mApp.update).not.toHaveBeenCalled();
  });
});
