/**
 * Global request-body cap on /api/* (backend/src/app.ts).
 *
 * /api/auth/login answers without authentication, so an uncapped body lets
 * any client grow the heap. Over MAX_API_REQUEST_BODY_BYTES the response is
 * 413 with the app's { error, message } JSON envelope; at or under it the
 * route runs normally.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
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

const TOKEN = "panel-token-must-be-16chars";
const app = createApp("http://localhost:3000");

// A JSON login body whose serialized length is exactly totalBytes: the
// token is the valid one, the rest is a "pad" field zod strips.
function paddedLoginBody(totalBytes: number): string {
  const prefix = `{"token":"${TOKEN}","pad":"`;
  const suffix = `"}`;
  return prefix + "A".repeat(totalBytes - prefix.length - suffix.length) + suffix;
}

function postLogin(body: string) {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("body limit on /api/*", () => {
  it("413 with the JSON error envelope for a body just over the limit", async () => {
    const res = await postLogin(paddedLoginBody(MAX_API_REQUEST_BODY_BYTES + 1));
    expect(res.status).toBe(413);
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("payload_too_large");
    expect(typeof body.message).toBe("string");
  });

  it("lets a body exactly at the limit through to the normal login path", async () => {
    const res = await postLogin(paddedLoginBody(MAX_API_REQUEST_BODY_BYTES));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it("rejects a token longer than the schema max with 400, not a crash", async () => {
    const res = await postLogin(JSON.stringify({ token: "x".repeat(1025) }));
    expect(res.status).toBe(400);
  });

  it("runs the normal 401 path for a 1024-char token (schema max boundary)", async () => {
    const res = await postLogin(JSON.stringify({ token: "x".repeat(1024) }));
    expect(res.status).toBe(401);
  });

  it("413 a protected route too (the cap is global on /api/*)", async () => {
    const res = await app.request("/api/servers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ name: "x".repeat(MAX_API_REQUEST_BODY_BYTES + 100) }),
    });
    expect(res.status).toBe(413);
  });

  it("413 from the Content-Length branch when the header exceeds the limit", async () => {
    // app.request() with a string body sends no Content-Length, so every
    // other test here exercises bodyLimit's streaming branch. This one sets
    // an explicit Content-Length above the limit on a tiny body: only the
    // header branch can answer 413 (the streamed body is far under it), and
    // the answer must still be the app's JSON error envelope.
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(MAX_API_REQUEST_BODY_BYTES + 1),
      },
      body: '{"token":"x"}',
    });
    expect(res.status).toBe(413);
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("payload_too_large");
  });
});
