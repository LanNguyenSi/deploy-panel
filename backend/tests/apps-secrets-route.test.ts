import { describe, expect, it, vi, beforeEach } from "vitest";

// Route-level coverage for the new app-secrets + required-env-keys surface
// (apps.ts) and its merge into GET .../preflight. Underlying crypto/store
// logic is unit-tested in app-secrets.test.ts / required-env-gate.test.ts;
// this file is scoped to HTTP status codes, validation, and — the
// non-negotiable one — that a secret value is NEVER present anywhere in an
// API response body.

vi.mock("../src/lib/relay.js", () => ({
  relayRequest: vi.fn(),
  RelayError: class RelayError extends Error {
    status: number;
    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("../src/lib/ownership.js", () => ({
  getActorContext: vi.fn(() => ({ userId: "user-a", isAdmin: false })),
  findOwnedServer: vi.fn(async () => ({ id: "srv-a", userId: "user-a" })),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    app: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("../src/lib/audit.js", () => ({
  audit: vi.fn(),
  getActor: vi.fn(() => "panel"),
  getActorUserId: vi.fn(() => "user-a"),
}));

vi.mock("../src/lib/app-secrets.js", () => ({
  listMaskedAppSecrets: vi.fn(),
  setAppSecret: vi.fn(),
  deleteAppSecret: vi.fn(),
}));

vi.mock("../src/lib/required-env-gate.js", () => ({
  evaluateRequiredEnv: vi.fn(),
}));

vi.mock("../src/lib/stream-deploy.js", () => ({ streamDeploy: vi.fn() }));
vi.mock("../src/lib/deploy-recovery.js", () => ({ recoverBrokenDeploy: vi.fn() }));

import { relayRequest } from "../src/lib/relay.js";
import { prisma } from "../src/lib/prisma.js";
import { listMaskedAppSecrets, setAppSecret, deleteAppSecret } from "../src/lib/app-secrets.js";
import { evaluateRequiredEnv } from "../src/lib/required-env-gate.js";
import { appsRouter } from "../src/routes/apps.js";
import { Hono } from "hono";

const mRelay = relayRequest as unknown as ReturnType<typeof vi.fn>;
const mAppFindUnique = (prisma.app as any).findUnique as ReturnType<typeof vi.fn>;
const mAppUpsert = (prisma.app as any).upsert as ReturnType<typeof vi.fn>;
const mAppUpdate = (prisma.app as any).update as ReturnType<typeof vi.fn>;
const mListSecrets = listMaskedAppSecrets as unknown as ReturnType<typeof vi.fn>;
const mSetSecret = setAppSecret as unknown as ReturnType<typeof vi.fn>;
const mDeleteSecret = deleteAppSecret as unknown as ReturnType<typeof vi.fn>;
const mEvalRequiredEnv = evaluateRequiredEnv as unknown as ReturnType<typeof vi.fn>;

function app() {
  const a = new Hono();
  a.route("/servers/:serverId/apps", appsRouter as unknown as Hono);
  return a;
}

const SECRET_VALUE = "sk-super-secret-token-value-12345";

describe("apps router — secrets + required-env-keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mAppUpsert.mockResolvedValue({ id: "app-1" });
    mAppUpdate.mockResolvedValue({ requiredEnvKeys: [] });
  });

  describe("GET /:name/secrets", () => {
    it("returns masked entries — the response body never contains the secret value", async () => {
      mAppFindUnique.mockResolvedValue({ id: "app-1", requiredEnvKeys: ["METRICS_API_TOKEN"] });
      mListSecrets.mockResolvedValue([
        { key: "METRICS_API_TOKEN", set: true, updatedAt: "2026-06-01T00:00:00.000Z" },
      ]);

      const res = await app().request("/servers/srv-a/apps/thd/secrets");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        secrets: [{ key: "METRICS_API_TOKEN", set: true, updatedAt: "2026-06-01T00:00:00.000Z" }],
        requiredEnvKeys: ["METRICS_API_TOKEN"],
      });
      expect(JSON.stringify(body)).not.toContain(SECRET_VALUE);
    });

    it("returns an empty list for an app the panel hasn't seen yet, without creating one", async () => {
      mAppFindUnique.mockResolvedValue(null);
      const res = await app().request("/servers/srv-a/apps/never-deployed/secrets");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ secrets: [], requiredEnvKeys: [] });
      expect(mListSecrets).not.toHaveBeenCalled();
    });

    it("rejects an invalid app name before touching the store", async () => {
      const res = await app().request("/servers/srv-a/apps/bad.name/secrets");
      expect(res.status).toBe(400);
      expect(mListSecrets).not.toHaveBeenCalled();
    });
  });

  describe("PUT /:name/secrets/:key", () => {
    it("sets the secret and echoes back only the key name — never the value", async () => {
      const res = await app().request("/servers/srv-a/apps/thd/secrets/METRICS_API_TOKEN", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: SECRET_VALUE }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ key: "METRICS_API_TOKEN", set: true });
      expect(JSON.stringify(body)).not.toContain(SECRET_VALUE);
      expect(mSetSecret).toHaveBeenCalledWith("app-1", "METRICS_API_TOKEN", SECRET_VALUE);
    });

    it("rejects an empty value with 400 and does not call the store", async () => {
      const res = await app().request("/servers/srv-a/apps/thd/secrets/METRICS_API_TOKEN", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "" }),
      });
      expect(res.status).toBe(400);
      expect(mSetSecret).not.toHaveBeenCalled();
    });

    it("rejects a key that doesn't match the allowed pattern", async () => {
      const res = await app().request("/servers/srv-a/apps/thd/secrets/bad-key!", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: SECRET_VALUE }),
      });
      expect(res.status).toBe(400);
      expect(mSetSecret).not.toHaveBeenCalled();
    });

    it.each([
      ["a newline", "line-one\nline-two"],
      ["a NUL byte", "before\x00after"],
      ["a carriage return", "before\rafter"],
      ["a tab", "before\tafter"],
    ])("rejects a value containing %s — defense against .env corruption", async (_label, value) => {
      const res = await app().request("/servers/srv-a/apps/thd/secrets/METRICS_API_TOKEN", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      expect(res.status).toBe(400);
      expect(mSetSecret).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /:name/secrets/:key", () => {
    it("deletes an existing secret", async () => {
      mAppFindUnique.mockResolvedValue({ id: "app-1", requiredEnvKeys: [] });
      mDeleteSecret.mockResolvedValue(true);

      const res = await app().request("/servers/srv-a/apps/thd/secrets/METRICS_API_TOKEN", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deleted: true });
    });

    it("404s when the app is unknown to the panel", async () => {
      mAppFindUnique.mockResolvedValue(null);
      const res = await app().request("/servers/srv-a/apps/thd/secrets/METRICS_API_TOKEN", { method: "DELETE" });
      expect(res.status).toBe(404);
      expect(mDeleteSecret).not.toHaveBeenCalled();
    });
  });

  describe("PUT /:name/required-env-keys", () => {
    it("stores the declared keys", async () => {
      mAppUpdate.mockResolvedValue({ requiredEnvKeys: ["METRICS_API_TOKEN", "DB_PASSWORD"] });

      const res = await app().request("/servers/srv-a/apps/thd/required-env-keys", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: ["METRICS_API_TOKEN", "DB_PASSWORD"] }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ requiredEnvKeys: ["METRICS_API_TOKEN", "DB_PASSWORD"] });
      expect(mAppUpdate).toHaveBeenCalledWith({
        where: { id: "app-1" },
        data: { requiredEnvKeys: ["METRICS_API_TOKEN", "DB_PASSWORD"] },
      });
    });

    it("rejects a malformed body", async () => {
      const res = await app().request("/servers/srv-a/apps/thd/required-env-keys", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: "not-an-array" }),
      });
      expect(res.status).toBe(400);
      expect(mAppUpdate).not.toHaveBeenCalled();
    });

    it("rejects an invalid key", async () => {
      const res = await app().request("/servers/srv-a/apps/thd/required-env-keys", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: ["not a valid key!"] }),
      });
      expect(res.status).toBe(400);
      expect(mAppUpdate).not.toHaveBeenCalled();
    });
  });

  describe("GET /:name/preflight — required-env merge", () => {
    it("passes through the relay result unchanged when the app declares no required keys", async () => {
      mRelay.mockResolvedValue({ passed: true, checks: [{ name: "compose", passed: true, message: "ok" }] });
      mAppFindUnique.mockResolvedValue({ id: "app-1", requiredEnvKeys: [] });

      const res = await app().request("/servers/srv-a/apps/thd/preflight");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ passed: true, checks: [{ name: "compose", passed: true, message: "ok" }] });
      expect(mEvalRequiredEnv).not.toHaveBeenCalled();
    });

    it("hard-fails preflight when a required env key is missing, even though the relay's own checks passed", async () => {
      mRelay.mockResolvedValue({ passed: true, checks: [{ name: "compose", passed: true, message: "ok" }] });
      mAppFindUnique.mockResolvedValue({ id: "app-1", requiredEnvKeys: ["METRICS_API_TOKEN"] });
      mEvalRequiredEnv.mockResolvedValue({
        requiredKeys: ["METRICS_API_TOKEN"],
        missing: ["METRICS_API_TOKEN"],
        check: { name: "required-env", passed: false, message: "Missing required env key(s): METRICS_API_TOKEN" },
      });

      const res = await app().request("/servers/srv-a/apps/thd/preflight");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.passed).toBe(false);
      expect(body.checks).toEqual([
        { name: "compose", passed: true, message: "ok" },
        { name: "required-env", passed: false, message: "Missing required env key(s): METRICS_API_TOKEN" },
      ]);
    });

    it("stays passed when the required env key resolves", async () => {
      mRelay.mockResolvedValue({ passed: true, checks: [] });
      mAppFindUnique.mockResolvedValue({ id: "app-1", requiredEnvKeys: ["METRICS_API_TOKEN"] });
      mEvalRequiredEnv.mockResolvedValue({
        requiredKeys: ["METRICS_API_TOKEN"],
        missing: [],
        check: { name: "required-env", passed: true, message: "All 1 required env key(s) resolve" },
      });

      const res = await app().request("/servers/srv-a/apps/thd/preflight");
      const body = await res.json();
      expect(body.passed).toBe(true);
    });
  });
});
