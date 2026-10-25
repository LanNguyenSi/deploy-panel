import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    deploy: { findMany: vi.fn(), count: vi.fn() },
  },
}));

import { prisma } from "../src/lib/prisma.js";
import { deploysRouter } from "../src/routes/deploys.js";
import { blockedDeployLogSteps } from "../src/lib/deploy-log.js";
import { Hono } from "hono";

const mDeploy = prisma.deploy as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
};

function app() {
  const a = new Hono<{ Variables: { userId?: string; isAdmin?: boolean } }>();
  a.use("/*", async (c, next) => {
    c.set("isAdmin", true);
    await next();
  });
  a.route("/deploys", deploysRouter as never);
  return a;
}

function row(id: string, status: string, log: string | null) {
  return {
    id,
    serverId: "s",
    appId: "a",
    commitBefore: null,
    commitAfter: null,
    status,
    duration: 1,
    log,
    triggeredBy: "manual",
    createdAt: new Date("2026-10-25T00:00:00Z"),
    app: { name: "x" },
    server: { name: "s", host: "h" },
  };
}

const blockedLog = JSON.stringify(
  blockedDeployLogSteps([], { passed: false, checks: [{ name: "disk", passed: false, message: "full", critical: true }] }),
);
const failedLog = JSON.stringify([{ name: "build", status: "failure", durationMs: 5, output: "boom" }]);

describe("GET /api/deploys blocked flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mDeploy.count.mockResolvedValue(6);
  });

  it("marks only preflight-blocked logs and never returns the raw log", async () => {
    mDeploy.findMany.mockResolvedValue([
      row("blocked", "failed", blockedLog),
      row("failed", "failed", failedLog),
      row("legacy", "failed", JSON.stringify("blocked by preflight")),
      row("nolog", "failed", null),
      row("garbage", "failed", "{not json"),
      row("ok", "success", failedLog),
    ]);
    const res = await app().request("/deploys");
    const body = (await res.json()) as { deploys: Array<Record<string, unknown>>; total: number };
    const flags = Object.fromEntries(body.deploys.map((d) => [d.id, d.blocked]));
    expect(flags).toEqual({
      blocked: true,
      failed: false,
      legacy: true,
      nolog: false,
      garbage: false,
      ok: false,
    });
    for (const d of body.deploys) expect("log" in d).toBe(false);
    expect(body.total).toBe(6);
  });
});
