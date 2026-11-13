/**
 * Structural guard for the requireAuth panel-token gate: the Bearer and the
 * panel_session cookie comparisons go through safeCompare (SHA-256 digests
 * of both values, then timingSafeEqual). A plain === returns the same
 * responses and only differs in timing, so behaviour tests cannot tell them
 * apart; the createHash spy can. If the helper changes (different digest,
 * fewer digests), update the expected counts to match it, do not remove
 * the guard.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
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

import { createHash } from "node:crypto";
import { createApp } from "../src/app.js";

const TOKEN = "panel-token-must-be-16chars";
const app = createApp("http://localhost:3000");

// requireAuth is mounted on both "/api/servers" and "/api/servers/*", so a
// request can pass the gate twice: count at least one comparison (2 digests).
function sha256Calls(): number {
  return vi.mocked(createHash).mock.calls.filter(([alg]) => alg === "sha256").length;
}

describe("requireAuth compares the panel token through safeCompare (structural guard)", () => {
  beforeEach(() => {
    vi.mocked(createHash).mockClear();
  });

  it("the Bearer path digests both values", async () => {
    const res = await app.request("/api/servers", { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(sha256Calls()).toBeGreaterThanOrEqual(2);
  });

  it("the panel_session cookie path digests both values", async () => {
    const res = await app.request("/api/servers", { headers: { Cookie: `panel_session=${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(sha256Calls()).toBeGreaterThanOrEqual(2);
  });

  it("a wrong Bearer is still compared through the digest (no early return)", async () => {
    const res = await app.request("/api/servers", { headers: { Authorization: `Bearer ${"x".repeat(TOKEN.length + 3)}` } });
    expect(res.status).toBe(401);
    expect(sha256Calls()).toBeGreaterThanOrEqual(2);
  });
});
