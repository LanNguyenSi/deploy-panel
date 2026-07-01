import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    apiKey: {
      findMany: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("../src/lib/audit.js", () => ({
  audit: vi.fn(),
}));

// api-keys.ts pulls in ../middleware/auth.js for the real hashApiKey() —
// that module imports config/index.js, which validates process.env and
// calls process.exit(1) on failure. Mock config the same way the v1-api
// exemplar does so the real (unmocked) hashApiKey still runs.
vi.mock("../src/config/index.js", () => ({
  config: {
    NODE_ENV: "test",
    PANEL_TOKEN: "panel-token-must-be-16chars",
    SESSION_SECRET: "session-secret-must-be-16chars",
    CORS_ORIGINS: "http://localhost:3000",
    FRONTEND_URL: "http://localhost:3000",
    PORT: 3001,
  },
}));

import { prisma } from "../src/lib/prisma.js";
import { audit } from "../src/lib/audit.js";
import { hashApiKey } from "../src/middleware/auth.js";
import { apiKeysRouter } from "../src/routes/api-keys.js";
import { Hono } from "hono";

const mApiKey = prisma.apiKey as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

function appFor() {
  const app = new Hono();
  app.route("/", apiKeysRouter as any);
  return app;
}

describe("api-keys POST / — key creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the plaintext secret exactly once, stores the HASH (not the plaintext), and uses the dp_ prefix", async () => {
    mApiKey.create.mockImplementation(async ({ data }: { data: { name: string; keyHash: string; keyPrefix: string } }) => ({
      id: "key-1",
      name: data.name,
      keyHash: data.keyHash,
      keyPrefix: data.keyPrefix,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    }));

    const res = await appFor().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "github-actions-prod" }),
    });

    expect(res.status).toBe(201);
    const rawBody = await res.text();
    const body = JSON.parse(rawBody) as {
      key: { id: string; name: string; secret: string; prefix: string };
      warning: string;
    };

    // dp_ prefix on the returned secret.
    expect(body.key.secret.startsWith("dp_")).toBe(true);

    // The plaintext secret appears exactly once in the whole response body —
    // it must never be echoed back a second time (e.g. duplicated into a
    // "prefix" or log-style field).
    const occurrences = rawBody.split(body.key.secret).length - 1;
    expect(occurrences).toBe(1);

    // prisma.apiKey.create must have been called with the HASH, never the
    // plaintext secret.
    expect(mApiKey.create).toHaveBeenCalledOnce();
    const createArgs = mApiKey.create.mock.calls[0][0];
    expect(createArgs.data.name).toBe("github-actions-prod");
    expect(createArgs.data.keyHash).toBe(hashApiKey(body.key.secret));
    expect(createArgs.data.keyHash).not.toBe(body.key.secret);
    expect(createArgs.data.keyPrefix).toBe(body.key.secret.slice(0, 10));
    expect(createArgs.data).not.toHaveProperty("key");
    expect(createArgs.data).not.toHaveProperty("secret");

    expect(audit).toHaveBeenCalledWith(
      "api_key.create",
      "github-actions-prod",
      expect.stringContaining(createArgs.data.keyPrefix),
      "panel",
    );
  });

  it("trims the name before persisting", async () => {
    mApiKey.create.mockImplementation(async ({ data }: { data: { name: string; keyHash: string; keyPrefix: string } }) => ({
      id: "key-2",
      name: data.name,
      keyHash: data.keyHash,
      keyPrefix: data.keyPrefix,
      createdAt: new Date(),
    }));

    await appFor().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  spaced-name  " }),
    });

    expect(mApiKey.create.mock.calls[0][0].data.name).toBe("spaced-name");
  });

  it("missing name: 400, prisma.apiKey.create NOT called", async () => {
    const res = await appFor().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
    expect(mApiKey.create).not.toHaveBeenCalled();
  });

  it("empty/whitespace-only name: 400, prisma.apiKey.create NOT called", async () => {
    const res = await appFor().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });

    expect(res.status).toBe(400);
    expect(mApiKey.create).not.toHaveBeenCalled();
  });
});

describe("api-keys GET / — list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns keys without secret/hash fields in the select", async () => {
    mApiKey.findMany.mockResolvedValue([]);
    const res = await appFor().request("/");
    expect(res.status).toBe(200);
    const select = mApiKey.findMany.mock.calls[0][0].select;
    expect(select).toEqual({ id: true, name: true, keyPrefix: true, lastUsedAt: true, createdAt: true });
  });
});

describe("api-keys DELETE /:id — revoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("success: deletes by id, audits, returns { deleted: true }", async () => {
    mApiKey.delete.mockResolvedValue({ id: "key-1", name: "github-actions-prod", keyPrefix: "dp_abcdefgh" });

    const res = await appFor().request("/key-1", { method: "DELETE" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean };
    expect(body.deleted).toBe(true);
    expect(mApiKey.delete).toHaveBeenCalledOnce();
    expect(mApiKey.delete).toHaveBeenCalledWith({ where: { id: "key-1" } });
    expect(audit).toHaveBeenCalledWith("api_key.revoke", "github-actions-prod", "prefix: dp_abcdefgh", "panel");
  });

  it("prisma rejects with 'record not found' (P2025-style): returns 404", async () => {
    mApiKey.delete.mockRejectedValue(new Error("Record to delete does not exist."));

    const res = await appFor().request("/does-not-exist", { method: "DELETE" });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
    expect(audit).not.toHaveBeenCalled();
  });

  it("FOOTGUN (pinned, not fixed): a real DB error (non-Prisma-not-found) is ALSO masked as 404", async () => {
    // The DELETE handler's catch block is unconditional — it catches every
    // rejection from prisma.apiKey.delete, including infra failures like a
    // dropped connection, and reports them identically to "key not found".
    // A caller (or monitoring) cannot distinguish "this key never existed"
    // from "the database is down" — both come back as a plain 404. This
    // test pins today's behavior; it does not assert the behavior is
    // correct. If the route is ever changed to rethrow non-not-found
    // errors, this test should be updated (and probably deleted) rather
    // than "fixed" to keep passing.
    mApiKey.delete.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5432"));

    const res = await appFor().request("/key-1", { method: "DELETE" });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("not_found");
    expect(body.message).toBe("API key not found");
  });
});

describe("api-keys — residual edge coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST / with a malformed JSON body falls back to {} and returns 400 (create NOT called)", async () => {
    // Exercises the `c.req.json().catch(() => ({}))` fallback: an unparseable
    // body becomes {}, which then fails the name guard -> 400.
    const res = await appFor().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not valid json",
    });

    expect(res.status).toBe(400);
    expect(mApiKey.create).not.toHaveBeenCalled();
  });

  it("GET / passes the findMany rows through into the { keys } body", async () => {
    const row = {
      id: "key-1",
      name: "ci",
      keyPrefix: "dp_abcdefgh",
      lastUsedAt: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
    mApiKey.findMany.mockResolvedValue([row]);

    const res = await appFor().request("/");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: Array<{ id: string; name: string; keyPrefix: string }> };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ id: "key-1", name: "ci", keyPrefix: "dp_abcdefgh" });
  });
});
