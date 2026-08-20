// agent-relay answers a rollback with HTTP 200 in every case (blocked,
// failed, and succeeded); see deploy-panel backend/src/routes/apps.ts and
// agent-relay src/api/routes.ts. The panel's fetch wrapper (`request()` in
// api.ts) only throws on a non-2xx status, so a blocked or failed rollback
// never reaches a `catch`; the caller must inspect the response body.
//
// This turns that body into the outcome a Rollback button click needs:
// which preflight check blocked the rollback (if any), or a generic
// failure message otherwise. Kept as a pure function (same pattern as
// `deployStatusBadge` in status.ts) so the branch that used to always show
// "Rollback triggered" can be unit-tested directly.

export interface RollbackPreflightCheck {
  name: string;
  passed: boolean;
  message: string;
}

export interface RollbackDeployResult {
  success?: boolean;
  blocked?: boolean;
  preflight?: { passed: boolean; checks: RollbackPreflightCheck[] };
}

export interface RollbackOutcome {
  ok: boolean;
  message: string;
}

export function describeRollbackResult(deploy: RollbackDeployResult): RollbackOutcome {
  if (deploy.success === true) {
    return { ok: true, message: "Rollback triggered" };
  }

  const failedChecks = deploy.preflight?.checks.filter((check) => !check.passed) ?? [];
  if (deploy.blocked) {
    if (failedChecks.length > 0) {
      const detail = failedChecks.map((check) => `${check.name}: ${check.message}`).join("; ");
      return { ok: false, message: `Rollback blocked by preflight (${detail})` };
    }
    return { ok: false, message: "Rollback blocked by preflight" };
  }

  return { ok: false, message: "Rollback failed" };
}
