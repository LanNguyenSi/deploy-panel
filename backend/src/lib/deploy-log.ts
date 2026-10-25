// Pure helpers for the shape of `Deploy.log` (a JSON steps array). No prisma
// import on purpose: route modules read logs through normalizeDeployLog and
// must stay importable where stream-deploy.ts is mocked.

export type DeployLogStep = { name: string; status: string; durationMs?: number; [k: string]: unknown };

/**
 * Marker (`step.kind`) carried by every step that stands for one failed relay
 * preflight check. The log of a blocked deploy is recognised by it: consumers
 * (the status fallback, the UI label, the MCP projection) never infer a
 * blocked deploy from step names.
 */
export const PREFLIGHT_CHECK_KIND = "preflight-check";

export function isPreflightCheckStep(step: unknown): boolean {
  return !!step && typeof step === "object" && (step as { kind?: unknown }).kind === PREFLIGHT_CHECK_KIND;
}

/**
 * Marker (`step.kind`) of the step written when the relay answered 409 (another
 * deploy is running): nothing was deployed, but it is a concurrency conflict,
 * not a failed preflight check, so it must not read "Blocked (preflight)" in
 * the UI. Blocked-deploy recognition (the status fallback) still counts it.
 */
export const CONFLICT_STEP_KIND = "deploy-conflict";

function isConflictStep(step: unknown): boolean {
  return !!step && typeof step === "object" && (step as { kind?: unknown }).kind === CONFLICT_STEP_KIND;
}

function isRawPreflightReport(value: unknown): boolean {
  return !!value && typeof value === "object" && Array.isArray((value as { checks?: unknown }).checks);
}

/** The bare string the streaming path stored for a `blocked` event without data, before the marker existed. */
const LEGACY_BLOCKED_STRING = "blocked by preflight";

/**
 * True when a stored `deploy.log` text is the log of a preflight-blocked
 * deploy. Recognised shapes: a steps array holding a marked step; and the
 * shapes written before the marker existed: the raw preflight report
 * (`{ checks: [...] }`), a steps array with that report appended (the old
 * non-streaming path), and the bare string "blocked by preflight" (the old
 * streaming path when the event carried no data).
 */
export function isBlockedDeployLog(log: string | null | undefined): boolean {
  if (!log) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(log);
  } catch {
    return false;
  }
  if (Array.isArray(parsed)) {
    return parsed.some(
      (s) => isPreflightCheckStep(s) || isConflictStep(s) || (isRawPreflightReport(s) && (s as { passed?: unknown }).passed === false),
    );
  }
  if (parsed === LEGACY_BLOCKED_STRING) return true;
  return isRawPreflightReport(parsed);
}

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
    return [{ name: "preflight", kind: PREFLIGHT_CHECK_KIND, status: "failure", durationMs: 0, message, output: message }];
  }
  return failed.map((c) => {
    const message = typeof c.message === "string" && c.message.length > 0 ? c.message : "check failed";
    const step: DeployLogStep = {
      name: typeof c.name === "string" && c.name.length > 0 ? c.name : "preflight",
      kind: PREFLIGHT_CHECK_KIND,
      status: "failure",
      durationMs: 0,
      message,
      output: message,
    };
    if (typeof c.critical === "boolean") step.critical = c.critical;
    return step;
  });
}

// The relay's own summary of its preflight run ("preflight",
// "preflight (pre-pull)", "preflight (post-pull)"). On a blocked deploy its
// output lists every check, passed ones included, which the per-check steps
// already carry.
const RELAY_PREFLIGHT_SUMMARY = /^preflight( \(.*\))?$/;

/**
 * The steps stored for a blocked deploy: whatever ran before (the panel's own
 * steps and the relay's streamed or returned steps) without a failed relay
 * preflight summary step, followed by one marked step per failed check. Both
 * the stream and the JSON path store this, so they stay identical.
 */
export function blockedDeployLogSteps(before: unknown, report: unknown): DeployLogStep[] {
  const kept = (Array.isArray(before) ? (before as DeployLogStep[]) : []).filter(
    (s) =>
      !(
        s &&
        typeof s === "object" &&
        !isPreflightCheckStep(s) &&
        typeof s.name === "string" &&
        RELAY_PREFLIGHT_SUMMARY.test(s.name) &&
        s.status !== "success" &&
        s.status !== "skipped"
      ),
  );
  return [...kept, ...blockedPreflightSteps(report)];
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
