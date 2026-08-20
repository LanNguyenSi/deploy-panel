import { describe, expect, it } from "vitest";
import { describeRollbackResult } from "./rollback";

describe("describeRollbackResult", () => {
  it("success:true reports ok with the success message", () => {
    expect(describeRollbackResult({ success: true })).toEqual({
      ok: true,
      message: "Rollback triggered",
    });
  });

  it("blocked:true with failing preflight checks reports the failing check name + message", () => {
    const result = describeRollbackResult({
      success: false,
      blocked: true,
      preflight: {
        passed: false,
        checks: [
          { name: "apps_root_mount_congruence", passed: true, message: "ok" },
          { name: "compose_bind_mount_sources_exist", passed: false, message: "bind mount source missing: /data/foo" },
        ],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("compose_bind_mount_sources_exist");
    expect(result.message).toContain("bind mount source missing: /data/foo");
    // Only the failing check is surfaced, not the passing one.
    expect(result.message).not.toContain("apps_root_mount_congruence");
  });

  it("blocked:true without a preflight report still reports a blocked failure", () => {
    expect(describeRollbackResult({ success: false, blocked: true })).toEqual({
      ok: false,
      message: "Rollback blocked by preflight",
    });
  });

  it("success:false without blocked reports a generic rollback failure", () => {
    expect(describeRollbackResult({ success: false })).toEqual({
      ok: false,
      message: "Rollback failed",
    });
  });

  it("success omitted (defensive default) is treated as a failure, not a success", () => {
    expect(describeRollbackResult({})).toEqual({
      ok: false,
      message: "Rollback failed",
    });
  });
});
