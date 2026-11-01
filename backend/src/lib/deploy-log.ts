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
  return matchBlockedLog(log, true);
}

/**
 * True only for a log blocked at preflight: the same shapes as
 * isBlockedDeployLog minus the relay-409 conflict marker. This is what the
 * "Blocked (preflight)" label needs; a log holding both a conflict step and a
 * preflight marker counts as blocked at preflight (the preflight marker wins).
 */
export function isPreflightBlockedDeployLog(log: string | null | undefined): boolean {
  return matchBlockedLog(log, false);
}

function matchBlockedLog(log: string | null | undefined, includeConflict: boolean): boolean {
  if (!log) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(log);
  } catch {
    return false;
  }
  if (Array.isArray(parsed)) {
    return parsed.some(
      (s) =>
        isPreflightCheckStep(s) ||
        (includeConflict && isConflictStep(s)) ||
        (isRawPreflightReport(s) && (s as { passed?: unknown }).passed === false),
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

/**
 * Name of the step agent-relay streams after an automatic rollback has rebuilt
 * and restarted the previous stack and probed it with the pre-deploy health
 * config. `success` means the restored stack is healthy; `failure` means
 * ROLLBACK UNHEALTHY (the app is down). The relay emits no such step when the
 * rollback is disabled, or blocked or failed earlier (git reset, preflight,
 * compose build, compose up), and older relays never emit it.
 */
export const ROLLBACK_HEALTH_STEP_NAME = "rollback: health check";

/**
 * How a finished deploy ended, as far as the app being up is concerned:
 *  - `success`: the deploy succeeded.
 *  - `rolled_back_healthy`: the deploy failed, the relay rolled back and its
 *    `rollback: health check` step succeeded, so the app runs the previous
 *    version (a warning, not an outage).
 *  - `outage`: a failed forward deploy whose step stream shows the rollback
 *    health check failed or was skipped, or has no such step (no rollback, a
 *    rollback that stopped before the health check, or an older relay). This
 *    is the behaviour from before the step existed; healthy is never assumed
 *    without the step.
 *  - `null`: no verdict here: not finished (running, pending), interrupted, a
 *    manual rollback row (`rolled_back`, or a `failed` row whose log is not a
 *    relay step stream: the raw relay result object, a nested `{ result }`
 *    preflight block, `[{ error }]` or a bare string; the app may well still
 *    be running), a missing or unparsable log, or a deploy blocked at
 *    preflight (nothing ran, the existing "Blocked" handling applies).
 *
 * The frontend repeats this rule in frontend/src/lib/status.ts for the live
 * deploy log, which only has steps; each side has its own tests for the same
 * cases, so change both together.
 */
export type DeployOutcome = "success" | "rolled_back_healthy" | "outage";

/** A relay step as streamed for a forward deploy: an object with a string `name` and `status`. */
function isRelayStep(step: unknown): boolean {
  if (!step || typeof step !== "object") return false;
  const s = step as { name?: unknown; status?: unknown };
  return typeof s.name === "string" && typeof s.status === "string";
}

export function classifyDeployOutcome(status: string, steps: readonly unknown[]): DeployOutcome | null {
  if (status === "success") return "success";
  if (status !== "failed") return null;
  if (steps.some((s) => isPreflightCheckStep(s) || isConflictStep(s))) return null;
  // Not a relay step stream (manual rollback payloads, error-only logs): no claim either way.
  if (!steps.some(isRelayStep)) return null;
  let health: unknown;
  for (const s of steps) {
    if (s && typeof s === "object" && (s as { name?: unknown }).name === ROLLBACK_HEALTH_STEP_NAME) health = s;
  }
  return (health as { status?: unknown } | undefined)?.status === "success" ? "rolled_back_healthy" : "outage";
}

/** classifyDeployOutcome for a stored `deploy.log` text of any historic shape. */
export function classifyDeployLogOutcome(status: string, log: string | null | undefined): DeployOutcome | null {
  if (status === "success") return "success";
  if (status !== "failed") return null;
  if (!log) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(log);
  } catch {
    return null;
  }
  // Only a steps array is a forward deploy's stream. A raw relay result object (manual rollback),
  // a nested `{ result }`, a preflight report and a bare string are not.
  if (!Array.isArray(parsed)) return null;
  if (matchBlockedLog(log, true)) return null;
  return classifyDeployOutcome(status, parsed);
}
