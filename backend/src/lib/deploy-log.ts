// Pure helpers for the shape of `Deploy.log` (a JSON steps array). No prisma
// import on purpose: route modules read logs through normalizeDeployLog and
// must stay importable where stream-deploy.ts is mocked.

export type DeployLogStep = { name: string; status: string; durationMs?: number; [k: string]: unknown };

interface PreflightCheckLike {
  name?: unknown;
  passed?: unknown;
  message?: unknown;
  critical?: unknown;
}

/**
 * Turns a relay preflight report (`{ passed, checks: [...] }`, the payload of
 * the SSE `blocked` event and `result.preflight` of the JSON response) into
 * deploy-log steps: one failed step per failed check, same shape as the relay's
 * own steps (`name`, `status`, `durationMs`, `output`) plus the check's
 * `message` and `critical` flag. Passed checks are not steps. A report that
 * names no failed check (or is not a report at all) still yields one step so a
 * blocked deploy never ends up with an empty log.
 */
export function blockedPreflightSteps(report: unknown): DeployLogStep[] {
  const checks: PreflightCheckLike[] =
    report && typeof report === "object" && Array.isArray((report as { checks?: unknown }).checks)
      ? ((report as { checks: PreflightCheckLike[] }).checks.filter((c) => c && typeof c === "object"))
      : [];
  const failed = checks.filter((c) => c.passed !== true);
  if (failed.length === 0) {
    const message = "Blocked by preflight";
    return [{ name: "preflight", status: "failure", durationMs: 0, message, output: message }];
  }
  return failed.map((c) => {
    const message = typeof c.message === "string" && c.message.length > 0 ? c.message : "check failed";
    const step: DeployLogStep = {
      name: typeof c.name === "string" && c.name.length > 0 ? c.name : "preflight",
      status: "failure",
      durationMs: 0,
      message,
      output: message,
    };
    if (typeof c.critical === "boolean") step.critical = c.critical;
    return step;
  });
}

/**
 * Maps a parsed `deploy.log` of any historic shape to a steps array: a steps
 * array passes through; a preflight report object stored by older blocked
 * deploys (`{ passed, checks }`) becomes its failed-check steps; a bare string
 * becomes a single failed `deploy` step carrying it; any other object (e.g. a
 * rollback's raw relay result) is wrapped as a one-element array.
 */
export function normalizeDeployLog(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === "string") {
    return [{ name: "deploy", status: "failure", durationMs: 0, output: parsed }];
  }
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { checks?: unknown }).checks)) {
    return blockedPreflightSteps(parsed);
  }
  return [parsed];
}
