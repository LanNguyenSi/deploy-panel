/**
 * Body limit on PUT /api/servers/:serverId/apps/:name/env (routes/apps.ts).
 *
 * The env replace route's own caps (ENV_MAX_ENTRIES entries of ENV_MAX_KEY
 * keys and ENV_MAX_VALUE values) allow far more than 1 MiB of JSON, so the
 * global /api/* cap in app.ts skips this path and the route carries its own
 * larger bodyLimit (ENV_REPLACE_MAX_BODY_BYTES). A body between the global
 * cap and the env cap must reach the route's own validation (not 413); the
 * same size on another route is still 413; a body above the env cap is 413
 * on the env route.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: {
      findUnique: vi.fn().mockResolvedValue({ id: "srv-1", userId: null, name: "srv-1" }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    apiKey: { findUnique: vi.fn(), update: vi.fn() },
    user: { upsert: vi.fn() },
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
    ALLOWED_GITHUB_LOGINS: "",
  },
  allowedGitHubLogins: [],
}));

vi.mock("../src/services/ssh-executor.js", () => {
  class SshError extends Error {
    constructor(message: string, readonly kind?: string) {
      super(message);
      this.name = "SshError";
    }
  }
  class SshTimeoutError extends Error {
    constructor(timeoutMs: number) {
      super(`SSH operation timed out after ${timeoutMs}ms`);
      this.name = "SshTimeoutError";
    }
  }
  return { executeSshCommand: vi.fn(), SshError, SshTimeoutError };
});

import { createApp, MAX_API_REQUEST_BODY_BYTES } from "../src/app.js";
import { ENV_MAX_KEY, ENV_MAX_VALUE, ENV_REPLACE_MAX_BODY_BYTES } from "../src/routes/apps.js";

const TOKEN = "panel-token-must-be-16chars";
const ENV_URL = "/api/servers/srv-1/apps/my-app/env";
const app = createApp("http://localhost:3000");

// { entries: [{ key, value }] } whose serialized length is exactly totalBytes:
// one entry with a single "A" run, long enough to be rejected by the route's
// own value cap (so the request proves it reached the handler's validation
// without touching the relay or the database beyond the ownership probe).
function envBody(totalBytes: number): string {
  const prefix = `{"entries":[{"key":"K","value":"`;
  const suffix = `"}]}`;
  return prefix + "A".repeat(totalBytes - prefix.length - suffix.length) + suffix;
}

function putEnv(body: string) {
  return app.request(ENV_URL, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body,
  });
}

describe("body limit on the env replace route", () => {
  it("the env cap is the global cap plus the room the entry caps allow", () => {
    // ENV_MAX_ENTRIES * (ENV_MAX_KEY + ENV_MAX_VALUE) is already ~16.4M and
    // the global cap is 1 MiB: the env route's limit is genuinely larger.
    expect(ENV_MAX_KEY).toBe(128);
    expect(ENV_MAX_VALUE).toBe(32_768);
    expect(ENV_REPLACE_MAX_BODY_BYTES).toBeGreaterThan(MAX_API_REQUEST_BODY_BYTES);
    expect(ENV_REPLACE_MAX_BODY_BYTES).toBeLessThan(512 * 1024 * 1024);
  });

  it("a body between 1 MiB and the env cap reaches the route's own validation, not 413", async () => {
    const size = MAX_API_REQUEST_BODY_BYTES + 64 * 1024;
    const body = envBody(size);
    expect(body.length).toBe(size);
    expect(size).toBeGreaterThan(MAX_API_REQUEST_BODY_BYTES);
    expect(size).toBeLessThan(ENV_REPLACE_MAX_BODY_BYTES);

    const res = await putEnv(body);
    // The route read the whole body and its value cap answered, not the
    // bodyLimit: 400 "Value for K exceeds 32768 chars", never 413.
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain(`exceeds ${ENV_MAX_VALUE}`);
  });

  it("the same size on another route is 413 (the global cap still applies there)", async () => {
    const size = MAX_API_REQUEST_BODY_BYTES + 64 * 1024;
    const res = await app.request("/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name: "A".repeat(size) }),
    });
    expect(res.status).toBe(413);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("payload_too_large");
  });

  it("a body above the env cap is 413 on the env route with the JSON envelope", async () => {
    const body = envBody(ENV_REPLACE_MAX_BODY_BYTES + 1);
    const res = await putEnv(body);
    expect(res.status).toBe(413);
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("payload_too_large");
  });
});
