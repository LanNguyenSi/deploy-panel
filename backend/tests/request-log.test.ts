/**
 * The request log never prints a query string (backend/src/lib/request-log.ts,
 * wired into Hono's logger in backend/src/app.ts).
 *
 * Hono's logger() prints the full request URL path, so the query string
 * reached stdout on both of its lines. The GitHub OAuth callback receives
 * `code` and `state` as query parameters, so every login wrote fresh
 * one-time OAuth codes into the container logs. The logger now runs its
 * lines through stripQuery, which removes `?` and everything after it from
 * the path token of the `<--` and `-->` lines. Method, path, status and
 * timing stay; a line without a query is byte-identical to before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { allowedLoginsMock, configMock } = vi.hoisted(() => ({
  allowedLoginsMock: [] as string[],
  configMock: {
    NODE_ENV: "test",
    PANEL_TOKEN: "panel-token-must-be-16chars",
    SESSION_SECRET: "session-secret-must-be-16chars",
    CORS_ORIGINS: "http://localhost:3000",
    FRONTEND_URL: "http://localhost:3000",
    BACKEND_URL: "http://localhost:3001",
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CLIENT_SECRET: "test-client-secret",
    PORT: 3001,
    ALLOWED_GITHUB_LOGINS: "",
  },
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    apiKey: { findUnique: vi.fn(), update: vi.fn() },
    user: { upsert: vi.fn() },
  },
}));

vi.mock("../src/config/index.js", () => ({
  config: configMock,
  allowedGitHubLogins: allowedLoginsMock,
  get hasGitHubOAuthConfigured() {
    return (
      (configMock.GITHUB_CLIENT_ID as string).length > 0 &&
      (configMock.GITHUB_CLIENT_SECRET as string).length > 0
    );
  },
}));

import { createApp } from "../src/app.js";
import { stripQuery } from "../src/lib/request-log.js";

describe("stripQuery unit cases", () => {
  it("strips the query from an incoming line", () => {
    expect(stripQuery("<-- GET /api/auth/github/callback?code=abc&state=xyz")).toBe(
      "<-- GET /api/auth/github/callback",
    );
  });

  it("strips the query from an outgoing line and keeps status and elapsed", () => {
    expect(stripQuery("--> GET /api/deploys?limit=5 200 4ms")).toBe("--> GET /api/deploys 200 4ms");
  });

  it("leaves an incoming line without a query byte-identical", () => {
    expect(stripQuery("<-- GET /api/health")).toBe("<-- GET /api/health");
  });

  it("leaves an outgoing line without a query byte-identical", () => {
    expect(stripQuery("--> GET /api/health 200 12ms")).toBe("--> GET /api/health 200 12ms");
  });

  it("drops an empty query (path ending in '?')", () => {
    expect(stripQuery("<-- GET /x?")).toBe("<-- GET /x");
    expect(stripQuery("--> GET /x? 200 3ms")).toBe("--> GET /x 200 3ms");
  });

  it("keeps an ANSI-colored status and elapsed on an outgoing line with a query", () => {
    expect(stripQuery("--> GET /x?y=1 \u001b[32m200\u001b[0m 5ms")).toBe(
      "--> GET /x \u001b[32m200\u001b[0m 5ms",
    );
  });

  it("passes a non-matching line through unchanged", () => {
    for (const line of [
      "hello world",
      "",
      "-->GET /x?y=1",
      "-- GET /x?y=1",
      "<--",
      "<-- GET",
    ]) {
      expect(stripQuery(line)).toBe(line);
    }
  });
});

describe("app request log has no query string", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("the OAuth callback logs two lines, with the path but no code, state or '?'", async () => {
    const app = createApp("http://localhost:3000");
    // No dp_oauth_state cookie, so the callback ends at state_mismatch and
    // no GitHub exchange runs; the two logger lines are all stdout sees.
    const res = await app.request(
      "/api/auth/github/callback?code=SECRETCODE&state=SECRETSTATE",
    );
    expect(res.status).toBe(302);
    const lines = logSpy.mock.calls.map((call) => String(call[0]));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toContain("GET /api/auth/github/callback");
      expect(line).not.toContain("SECRETCODE");
      expect(line).not.toContain("SECRETSTATE");
      expect(line).not.toContain("?");
    }
  });

  it("a request without a query logs the same two lines as before the change", async () => {
    const app = createApp("http://localhost:3000");
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const lines = logSpy.mock.calls.map((call) => String(call[0]));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("<-- GET /api/health");
    // Hono colorizes the status when the terminal allows it, so compare the
    // outgoing line with the ANSI escape sequences removed.
    const plain = lines[1].replace(/\u001b\[\d+m/g, "");
    expect(plain).toMatch(/^--> GET \/api\/health 200 [\d,]+m?s$/);
  });

  it("another route with a query logs the path without the query", async () => {
    const app = createApp("http://localhost:3000");
    // /api/deploys is behind the auth middleware; the logger runs first, so
    // both lines print even though the unauthenticated request ends 401.
    const res = await app.request("/api/deploys?limit=5");
    expect(res.status).toBe(401);
    const lines = logSpy.mock.calls.map((call) => String(call[0]));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toContain("GET /api/deploys");
      expect(line).not.toContain("limit=5");
      expect(line).not.toContain("?");
    }
  });
});
