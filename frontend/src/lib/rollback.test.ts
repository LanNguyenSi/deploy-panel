import { describe, expect, it } from "vitest";
import { describeRollbackResult } from "./rollback";

describe("describeRollbackResult", () => {
  it("success:true reports ok with the success message", () => {
    expect(describeRollbackResult({ success: true })).toEqual({
      ok: true,
      message: "Rollback triggered",
    });
  });

  it("blocked:true with failing preflight checks reports the failing check name(s) only, not the full message", () => {
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
    // Only the failing check's NAME is surfaced in the toast — the full
    // message (600-900+ chars measured) goes to the preflight panel
    // instead (see page.tsx handleRollback), not the 4s-auto-dismiss toast.
    expect(result.message).not.toContain("bind mount source missing: /data/foo");
    // Only the failing check is surfaced, not the passing one.
    expect(result.message).not.toContain("apps_root_mount_congruence");
  });

  it("blocked:true with multiple failing checks joins all their names", () => {
    const result = describeRollbackResult({
      success: false,
      blocked: true,
      preflight: {
        passed: false,
        checks: [
          { name: "check_a", passed: false, message: "a failed" },
          { name: "check_b", passed: false, message: "b failed" },
        ],
      },
    });

    expect(result).toEqual({
      ok: false,
      message: "Rollback blocked by preflight: check_a, check_b",
    });
  });

  it("blocked:true without a preflight report still reports a blocked failure", () => {
    expect(describeRollbackResult({ success: false, blocked: true })).toEqual({
      ok: false,
      message: "Rollback blocked by preflight",
    });
  });

  it("blocked:true with preflight present but checks missing falls back to the generic blocked message", () => {
    expect(
      describeRollbackResult({
        success: false,
        blocked: true,
        preflight: { passed: false } as unknown as { passed: boolean; checks: Array<{ name: string; passed: boolean; message: string }> },
      }),
    ).toEqual({
      ok: false,
      message: "Rollback blocked by preflight",
    });
  });

  it("blocked:true with preflight present but checks empty falls back to the generic blocked message", () => {
    expect(
      describeRollbackResult({ success: false, blocked: true, preflight: { passed: false, checks: [] } }),
    ).toEqual({
      ok: false,
      message: "Rollback blocked by preflight",
    });
  });

  it("blocked:true with preflight.passed false but every check passing falls back to the generic blocked message", () => {
    expect(
      describeRollbackResult({
        success: false,
        blocked: true,
        preflight: {
          passed: false,
          checks: [
            { name: "check_a", passed: true, message: "ok" },
            { name: "check_b", passed: true, message: "ok" },
          ],
        },
      }),
    ).toEqual({
      ok: false,
      message: "Rollback blocked by preflight",
    });
  });

  // defensive: not currently emitted by agent-relay (non-preflight failures
  // are HTTP 400 { error } — see backend/src/routes/apps.ts rollback route,
  // which never reaches describeRollbackResult with success:false/blocked
  // undefined for that path; kept in case a future relay version reports
  // failures this way instead).
  it("success:false without blocked reports a generic rollback failure (defensive: not currently emitted by agent-relay)", () => {
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
