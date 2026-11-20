/**
 * CORS origin list tolerates trailing slashes (backend/src/app.ts).
 *
 * A browser never sends a trailing slash in Origin, so a configured
 * CORS_ORIGINS entry "https://a.example/" used to never match and every
 * credentialed cross-origin call from that page was blocked by the browser.
 * Each entry is now trimmed of whitespace and trailing slashes at app
 * construction, so the preflight answers the plain origin. An entry that is
 * only whitespace or the empty list stays harmless: no browser Origin ever
 * equals "", so such entries never match anything.
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

import { createApp } from "../src/app.js";

// Slashed and whitespace-padded entries, one multi-slash entry, and a plain
// entry that must keep working unchanged.
const app = createApp("https://a.example/, https://b.example// ,http://localhost:3000,   ");

function preflight(origin: string) {
  return app.request("/api/health", {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "GET",
    },
  });
}

describe("CORS origin list with trailing slashes", () => {
  it("preflight from https://a.example is allowed by the entry https://a.example/", async () => {
    const res = await preflight("https://a.example");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://a.example");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("preflight from https://b.example is allowed by the multi-slash entry", async () => {
    const res = await preflight("https://b.example");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://b.example");
  });

  it("a plain entry without a slash still matches (actual request keeps the ACAO header)", async () => {
    const res = await app.request("/api/health", { headers: { Origin: "http://localhost:3000" } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
  });

  it("an origin not in the list gets no Access-Control-Allow-Origin", async () => {
    const res = await preflight("https://evil.example");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("the whitespace-only entry matches nothing: no Origin, an empty Origin and '/' get no ACAO", async () => {
    const none = await app.request("/api/health");
    expect(none.headers.get("Access-Control-Allow-Origin")).toBeNull();
    for (const origin of ["", "/"]) {
      const res = await app.request("/api/health", { headers: { Origin: origin } });
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
  });

  it("the exact slashed origin is never allowed (browsers never send it, the list holds trimmed values)", async () => {
    const res = await preflight("https://a.example/");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
