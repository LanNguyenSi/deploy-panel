import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    deploy: { findMany: vi.fn(), count: vi.fn() },
  },
}));

import { prisma } from "../src/lib/prisma.js";
import { deploysRouter } from "../src/routes/deploys.js";
import { blockedDeployLogSteps, isBlockedDeployLog, isPreflightBlockedDeployLog, CONFLICT_STEP_KIND, PREFLIGHT_CHECK_KIND } from "../src/lib/deploy-log.js";
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
const conflictLog = JSON.stringify([
  { name: "deploy", kind: CONFLICT_STEP_KIND, status: "failure", durationMs: 0, output: "another deploy is running" },
]);
// An env-preflight refusal (the panel's own check) is stored with the preflight-check marker.
const envPreflightLog = JSON.stringify([
  { name: "env", kind: PREFLIGHT_CHECK_KIND, status: "failure", durationMs: 0, message: "DATABASE_URL missing", output: "DATABASE_URL missing" },
]);
const failedLog = JSON.stringify([{ name: "build", status: "failure", durationMs: 5, output: "boom" }]);

describe("GET /api/deploys blocked flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mDeploy.count.mockResolvedValue(8);
  });

  it("marks only preflight-blocked logs and never returns the raw log", async () => {
    mDeploy.findMany.mockResolvedValue([
      row("blocked", "failed", blockedLog),
      row("failed", "failed", failedLog),
      row("legacy", "failed", JSON.stringify("blocked by preflight")),
      row("nolog", "failed", null),
      row("garbage", "failed", "{not json"),
      row("ok", "success", failedLog),
      row("conflict", "failed", conflictLog),
      row("env", "failed", envPreflightLog),
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
      conflict: false,
      env: true,
    });
    for (const d of body.deploys) expect("log" in d).toBe(false);
    expect(body.total).toBe(8);
  });
});

describe("isPreflightBlockedDeployLog", () => {
  it("is false for a relay 409 conflict log, which isBlockedDeployLog still counts", () => {
    expect(isPreflightBlockedDeployLog(conflictLog)).toBe(false);
    expect(isBlockedDeployLog(conflictLog)).toBe(true);
  });

  it("is true for a preflight-check log and for an env-preflight log", () => {
    expect(isPreflightBlockedDeployLog(blockedLog)).toBe(true);
    expect(isPreflightBlockedDeployLog(envPreflightLog)).toBe(true);
  });

  it("is true when both markers are present (the preflight marker wins)", () => {
    const both = JSON.stringify([...JSON.parse(conflictLog), ...JSON.parse(envPreflightLog)]);
    expect(isPreflightBlockedDeployLog(both)).toBe(true);
  });

  it("is false for a plain failure, a null log and invalid JSON", () => {
    expect(isPreflightBlockedDeployLog(failedLog)).toBe(false);
    expect(isPreflightBlockedDeployLog(null)).toBe(false);
    expect(isPreflightBlockedDeployLog("{nope")).toBe(false);
  });
});
