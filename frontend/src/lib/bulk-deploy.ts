import { PREFLIGHT_CHECK_KIND, normalizeDeploySteps } from "@/components/DeploySteps";

/** One failed step of a finished deploy: for a blocked deploy, one failed preflight check. */
export interface BulkFailure {
  check: string;
  message: string;
  /** The failed preflight check is a critical one (it blocks even a forced deploy). */
  critical?: boolean;
  /** The failure is a failed preflight check, i.e. the deploy was blocked. */
  preflight?: boolean;
}

/** One app of a bulk deploy, updated as its deploy settles. */
export interface BulkEntry {
  app: string;
  deployId: string;
  status: string;
  failures: BulkFailure[];
}

export interface BulkResult {
  entries: BulkEntry[];
  /** Status polls done so far; polling stops at BULK_MAX_POLLS. */
  polls: number;
}

/**
 * First poll fires at once, then every BULK_POLL_MS; about ten minutes in total,
 * the same budget the backend gives a single deploy (servers.ts, stream-deploy.ts).
 * Two minutes was too short: apps with a long build (depsight takes 100-180 s)
 * outlived the polling and their badge froze on "Running".
 */
export const BULK_POLL_MS = 3000;
export const BULK_MAX_POLLS = 200;

export function isSettled(entry: BulkEntry): boolean {
  return entry.status !== "running";
}

/** Polling has given up; entries that are still running now have an unknown outcome. */
export function pollingStopped(result: BulkResult): boolean {
  return result.polls >= BULK_MAX_POLLS;
}

/**
 * An entry polling gave up on: its last known status is "running", but that is
 * no longer being refreshed, so the page must not keep showing it as running.
 */
export function isUnknownEntry(entry: BulkEntry, result: BulkResult): boolean {
  return !isSettled(entry) && pollingStopped(result);
}

/** Badge for an entry whose outcome polling never saw (see isUnknownEntry). */
export const UNKNOWN_BADGE = { className: "badge-neutral", label: "Unknown" } as const;

/** Line shown under an unknown entry, pointing to where the outcome is recorded. */
export const UNKNOWN_HINT = "still running when polling stopped; check the deploy history for its outcome";

/** A finished entry whose failures are failed preflight checks. */
export function isBlockedEntry(entry: BulkEntry): boolean {
  return isSettled(entry) && entry.failures.some((f) => f.preflight === true);
}

/** The failed steps (non-success, non-skipped) of a stored deploy log, in order. */
export function failuresFromLog(log: string | null): BulkFailure[] {
  if (!log) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(log);
  } catch {
    return [];
  }
  return normalizeDeploySteps(parsed)
    .filter((s) => s.status !== "success" && s.status !== "skipped")
    .map((s) => ({
      check: s.name,
      message: s.message ?? s.output ?? "",
      ...(s.critical === true ? { critical: true } : {}),
      ...(s.kind === PREFLIGHT_CHECK_KIND ? { preflight: true } : {}),
    }));
}

/** Entries of the 202 response: an app whose setup failed is already settled with its error. */
export function initialBulkEntries(
  deploys: Array<{ app: string; deployId: string; status: string; error?: string }>,
): BulkEntry[] {
  return deploys.map((d) => ({
    app: d.app,
    deployId: d.deployId,
    status: d.status,
    failures: d.status === "running" ? [] : [{ check: "deploy", message: d.error ?? "could not start" }],
  }));
}

/** One line per app for the result summary: "check [critical] (message); check2 (message2)". */
export function describeFailures(failures: BulkFailure[]): string {
  return failures
    .map((f) => {
      const name = f.critical === true ? `${f.check} [critical]` : f.check;
      return f.message ? `${name} (${f.message})` : name;
    })
    .join("; ");
}

/** The one-line summary announced to assistive technology (the live region). */
export function bulkSummary(result: BulkResult): string {
  const pending = result.entries.filter((e) => !isSettled(e)).length;
  if (pending === 0) return `All ${result.entries.length} deploys finished.`;
  if (pollingStopped(result)) {
    return `Stopped waiting for ${pending} deploy(s). Check the deploy history for their outcome.`;
  }
  return `Waiting for ${pending} deploy(s).`;
}
