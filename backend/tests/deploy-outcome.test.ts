import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    deploy: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
  },
}));

import { Hono } from "hono";
import { prisma } from "../src/lib/prisma.js";
import { deploysRouter } from "../src/routes/deploys.js";
import {
  CONFLICT_STEP_KIND,
  PREFLIGHT_CHECK_KIND,
  ROLLBACK_HEALTH_STEP_NAME,
  classifyDeployLogOutcome,
  classifyDeployOutcome,
} from "../src/lib/deploy-log.js";

const mDeploy = prisma.deploy as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
};

const fail = (name: string) => ({ name, status: "failure", durationMs: 1 });
const ok = (name: string) => ({ name, status: "success", durationMs: 1 });
const rollbackSteps = [ok("rollback: git reset"), ok("rollback: preflight"), ok("rollback: compose build"), ok("rollback: compose up")];

describe("classifyDeployOutcome: failed deploy x rollback health step", () => {
  const forward = [ok("git pull"), fail("health check")];

  it("step absent (older relay, rollback disabled): outage, healthy is never assumed", () => {
    expect(classifyDeployOutcome("failed", forward)).toBe("outage");
  });

  it("step absent after a rollback that ran (older relay): outage", () => {
    expect(classifyDeployOutcome("failed", [...forward, ...rollbackSteps])).toBe("outage");
  });

  it("step success: rolled back healthy", () => {
    expect(classifyDeployOutcome("failed", [...forward, ...rollbackSteps, ok(ROLLBACK_HEALTH_STEP_NAME)])).toBe(
      "rolled_back_healthy",
    );
  });

  it("step failure (ROLLBACK UNHEALTHY): outage", () => {
    expect(classifyDeployOutcome("failed", [...forward, ...rollbackSteps, fail(ROLLBACK_HEALTH_STEP_NAME)])).toBe("outage");
  });

  it("step skipped (no health endpoint configured): outage, not healthy", () => {
    expect(
      classifyDeployOutcome("failed", [...forward, ...rollbackSteps, { name: ROLLBACK_HEALTH_STEP_NAME, status: "skipped" }]),
    ).toBe("outage");
  });

  it("rollback step failed before the health check (compose up failed): outage", () => {
    expect(
      classifyDeployOutcome("failed", [...forward, ok("rollback: git reset"), ok("rollback: preflight"), ok("rollback: compose build"), fail("rollback: compose up")]),
    ).toBe("outage");
  });

  it("rollback preflight blocked: outage", () => {
    expect(classifyDeployOutcome("failed", [...forward, ok("rollback: git reset"), fail("rollback: preflight")])).toBe("outage");
  });

  it("a later health step wins over an earlier one", () => {
    expect(
      classifyDeployOutcome("failed", [ok(ROLLBACK_HEALTH_STEP_NAME), fail(ROLLBACK_HEALTH_STEP_NAME)]),
    ).toBe("outage");
  });

  it("non-object steps are ignored", () => {
    expect(classifyDeployOutcome("failed", [null, "x", 3])).toBe("outage");
  });
});

describe("classifyDeployOutcome: other statuses and shapes", () => {
  it("success stays success", () => {
    expect(classifyDeployOutcome("success", [ok("git pull")])).toBe("success");
  });

  it.each(["running", "pending", "interrupted", "rolled_back"])("%s has no verdict", (status) => {
    expect(classifyDeployOutcome(status, [ok(ROLLBACK_HEALTH_STEP_NAME)])).toBeNull();
  });

  it("a preflight-blocked deploy has no verdict (nothing ran)", () => {
    expect(classifyDeployOutcome("failed", [{ name: "disk", kind: PREFLIGHT_CHECK_KIND, status: "failure" }])).toBeNull();
  });

  it("a relay 409 conflict has no verdict", () => {
    expect(classifyDeployOutcome("failed", [{ name: "deploy", kind: CONFLICT_STEP_KIND, status: "failure" }])).toBeNull();
  });
});

describe("classifyDeployLogOutcome: stored log shapes", () => {
  it("healthy rollback in a steps array", () => {
    expect(classifyDeployLogOutcome("failed", JSON.stringify([fail("health check"), ok(ROLLBACK_HEALTH_STEP_NAME)]))).toBe(
      "rolled_back_healthy",
    );
  });

  it.each([
    ["no log", null],
    ["unparsable log", "{nope"],
    ["bare error string", JSON.stringify("Relay returned invalid JSON")],
  ])("failed with %s: outage", (_label, log) => {
    expect(classifyDeployLogOutcome("failed", log)).toBe("outage");
  });

  it("legacy blocked string and raw preflight report: no verdict", () => {
    expect(classifyDeployLogOutcome("failed", JSON.stringify("blocked by preflight"))).toBeNull();
    expect(classifyDeployLogOutcome("failed", JSON.stringify({ passed: false, checks: [{ name: "disk", passed: false }] }))).toBeNull();
  });
});

describe("panel deploy routes carry the outcome", () => {
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
      id, serverId: "s", appId: "a", commitBefore: null, commitAfter: null, status, duration: 1, log,
      triggeredBy: "manual", createdAt: new Date("2026-10-25T00:00:00Z"),
      app: { name: "x", repoUrl: null, branch: "main" }, server: { name: "s", host: "h", userId: "u" },
    };
  }
  const healthyLog = JSON.stringify([fail("health check"), ok(ROLLBACK_HEALTH_STEP_NAME)]);
  const unhealthyLog = JSON.stringify([fail("health check"), fail(ROLLBACK_HEALTH_STEP_NAME)]);

  beforeEach(() => {
    vi.clearAllMocks();
    mDeploy.count.mockResolvedValue(3);
  });

  it("list: outcome per row", async () => {
    mDeploy.findMany.mockResolvedValue([
      row("healthy", "failed", healthyLog),
      row("down", "failed", unhealthyLog),
      row("ok", "success", healthyLog),
    ]);
    const body = (await (await app().request("/deploys")).json()) as { deploys: Array<{ id: string; outcome: string }> };
    expect(Object.fromEntries(body.deploys.map((d) => [d.id, d.outcome]))).toEqual({
      healthy: "rolled_back_healthy",
      down: "outage",
      ok: "success",
    });
  });

  it("detail: outcome next to the steps", async () => {
    mDeploy.findUnique.mockResolvedValue(row("healthy", "failed", healthyLog));
    const body = (await (await app().request("/deploys/healthy")).json()) as { deploy: { outcome: string; steps: unknown[] } };
    expect(body.deploy.outcome).toBe("rolled_back_healthy");
    expect(body.deploy.steps).toHaveLength(2);
  });
});
