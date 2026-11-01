import { describe, expect, it } from "vitest";
import { classifyDeployOutcome, deployStatusBadge, serverStatusBadge } from "./status";

describe("deployStatusBadge", () => {
  it.each([
    ["success", { className: "badge-success", label: "Success" }],
    ["failed", { className: "badge-danger", label: "Failed" }],
    ["rolled_back", { className: "badge-warning", label: "Rolled back" }],
    ["running", { className: "badge-info", label: "Running" }],
    ["pending", { className: "badge-neutral", label: "Pending" }],
    ["interrupted", { className: "badge-warning", label: "Interrupted" }],
  ] as const)("maps %s to the exact badge", (status, expected) => {
    expect(deployStatusBadge(status)).toEqual(expected);
  });

  it("labels a failed deploy that was blocked at preflight; the flag changes nothing for other statuses", () => {
    expect(deployStatusBadge("failed", true)).toEqual({ className: "badge-warning", label: "Blocked (preflight)" });
    expect(deployStatusBadge("failed", false)).toEqual({ className: "badge-danger", label: "Failed" });
    expect(deployStatusBadge("success", true)).toEqual({ className: "badge-success", label: "Success" });
  });

  it("labels blocked only for failed: blocked true with status success stays 'Success'", () => {
    expect(deployStatusBadge("success", true).label).toBe("Success");
    expect(deployStatusBadge("interrupted", true).label).toBe("Interrupted");
  });

  it("falls back to badge-neutral with the raw status for an unknown status", () => {
    expect(deployStatusBadge("totally-unknown")).toEqual({
      className: "badge-neutral",
      label: "totally-unknown",
    });
  });
});

describe("serverStatusBadge", () => {
  it.each([
    ["online", { className: "badge-success", label: "online" }],
    ["offline", { className: "badge-danger", label: "offline" }],
    ["no-relay", { className: "badge-warning", label: "no-relay" }],
    ["unknown", { className: "badge-neutral", label: "unknown" }],
    ["bogus-future-status", { className: "badge-neutral", label: "bogus-future-status" }],
  ] as const)("maps %s to the exact badge", (status, expected) => {
    expect(serverStatusBadge(status)).toEqual(expected);
  });

  it("maps auth to an explicit label so it cannot read as 'authenticated'", () => {
    const badge = serverStatusBadge("auth");
    expect(badge.className).toBe("badge-warning");
    expect(badge.label).toBe("auth failed");
    expect(badge.hint).toContain("relay token");
    expect(badge.title).toContain("check the relay token");
  });

  it("only auth carries a hint and a title; the others render neither", () => {
    for (const status of ["online", "offline", "no-relay", "unknown", "whatever"]) {
      expect(serverStatusBadge(status).hint).toBeUndefined();
      expect(serverStatusBadge(status).title).toBeUndefined();
    }
  });
});

describe("deployStatusBadge: rollback outcome", () => {
  it("labels a failed deploy whose rollback is healthy as a warning, apart from Failed", () => {
    expect(deployStatusBadge("failed", false, "rolled_back_healthy")).toEqual({ className: "badge-warning", label: "Rolled back (healthy)" });
  });

  it("an outage, no outcome and a null outcome stay a red Failed", () => {
    const failed = { className: "badge-danger", label: "Failed" };
    expect(deployStatusBadge("failed", false, "outage")).toEqual(failed);
    expect(deployStatusBadge("failed", false)).toEqual(failed);
    expect(deployStatusBadge("failed", false, null)).toEqual(failed);
  });

  it("the outcome only applies to failed deploys, and blocked wins", () => {
    expect(deployStatusBadge("success", false, "rolled_back_healthy").label).toBe("Success");
    expect(deployStatusBadge("failed", true, "rolled_back_healthy").label).toBe("Blocked (preflight)");
  });
});

describe("classifyDeployOutcome", () => {
  const step = (name: string, status: string, kind?: string) => ({ name, status, kind });
  const forward = [step("git pull", "success"), step("health check", "failure")];
  const rollback = [step("rollback: git reset", "success"), step("rollback: compose up", "success")];

  it("health step absent (older relay): outage", () => {
    expect(classifyDeployOutcome("failed", forward)).toBe("outage");
    expect(classifyDeployOutcome("failed", [...forward, ...rollback])).toBe("outage");
  });

  it("health step success: rolled back healthy", () => {
    expect(classifyDeployOutcome("failed", [...forward, ...rollback, step("rollback: health check", "success")])).toBe("rolled_back_healthy");
  });

  it("health step failure or skipped: outage", () => {
    expect(classifyDeployOutcome("failed", [...forward, ...rollback, step("rollback: health check", "failure")])).toBe("outage");
    expect(classifyDeployOutcome("failed", [...forward, ...rollback, step("rollback: health check", "skipped")])).toBe("outage");
  });

  it("a rollback step failed before the health check: outage", () => {
    expect(classifyDeployOutcome("failed", [...forward, step("rollback: git reset", "success"), step("rollback: compose up", "failure")])).toBe("outage");
  });

  it("success, and no verdict for unfinished, interrupted, rolled_back, blocked and conflict", () => {
    expect(classifyDeployOutcome("success", [])).toBe("success");
    for (const status of ["running", "pending", "interrupted", "rolled_back"]) {
      expect(classifyDeployOutcome(status, [step("rollback: health check", "success")])).toBeNull();
    }
    expect(classifyDeployOutcome("failed", [step("disk", "failure", "preflight-check")])).toBeNull();
    expect(classifyDeployOutcome("failed", [step("deploy", "failure", "deploy-conflict")])).toBeNull();
  });
});
