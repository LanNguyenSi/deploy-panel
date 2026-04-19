import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    apiKey: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
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
  },
}));

import { prisma } from "../src/lib/prisma.js";
import { requireAuth } from "../src/middleware/auth.js";

const findUnique = prisma.apiKey.findUnique as unknown as ReturnType<typeof vi.fn>;

function probeApp() {
  const app = new Hono();
  app.use("*", requireAuth);
  app.get("/probe", (c) => c.json({ ok: true }));
  return app;
}

describe("requireAuth — ApiKey revoked handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a revoked dp_ API key with 401", async () => {
    findUnique.mockResolvedValue({
      id: "key-1",
      keyHash: "hash",
      name: "project-pilot",
      userId: "user-1",
      revokedAt: new Date("2026-01-01"),
    });

    const res = await probeApp().request("/probe", {
      headers: { Authorization: "Bearer dp_revokedkeyvalue123" },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/invalid or revoked/i);
  });

  it("accepts an unrevoked dp_ API key", async () => {
    findUnique.mockResolvedValue({
      id: "key-1",
      keyHash: "hash",
      name: "project-pilot",
      userId: "user-1",
      revokedAt: null,
    });

    const res = await probeApp().request("/probe", {
      headers: { Authorization: "Bearer dp_validkeyvalue123" },
    });

    expect(res.status).toBe(200);
  });

  it("rejects dp_ keys with no matching row at all", async () => {
    findUnique.mockResolvedValue(null);

    const res = await probeApp().request("/probe", {
      headers: { Authorization: "Bearer dp_unknown" },
    });

    expect(res.status).toBe(401);
  });
});
